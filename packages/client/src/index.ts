// Thin helper around RxDB's replication plugin. Tub speaks the RxDB replication
// protocol; this package only wires up URL + bearer credential. Keep it small.
import type { RxCollection, RxJsonSchema } from "rxdb"
import { replicateRxCollection, type RxReplicationState } from "rxdb/plugins/replication"
import { Subject } from "rxjs"
import {
  MAX_ID_LENGTH,
  MAX_PULL_BATCH,
  MAX_PUSH_BATCH,
  type Checkpoint,
  type Document,
  type PullResponse,
  type PushResponse,
} from "@mkline13/tub-shared"

export type { Checkpoint, Document } from "@mkline13/tub-shared"

export type TubClientOptions = {
  /** Base URL of the Tub server, e.g. https://tub.example.com */
  url: string
  /** Bearer credential secret issued by `tub credentials create`. */
  secret: string
}

export type TubReplicationOptions<T extends Document> = TubClientOptions & {
  collection: RxCollection<T>
  /** Tub scope to sync with. Defaults to the collection name (the MVP convention). */
  scope?: string
  /** Keep syncing and listen for server changes (default true). */
  live?: boolean
  /** Documents per pull/push request (default 100). */
  batchSize?: number
  /** Milliseconds to wait before retrying after an error (default 5000). */
  retryTime?: number
  autoStart?: boolean
  /** Override fetch, e.g. for tests. */
  fetch?: typeof fetch
}

export function authHeaders(opts: TubClientOptions): Record<string, string> {
  return { authorization: `Bearer ${opts.secret}` }
}

/** Tub requires TLS for remote connections; plain HTTP is only accepted for loopback. */
export function assertSecureUrl(url: string): URL {
  const parsed = new URL(url)
  const host = parsed.hostname.replace(/^\[|\]$/g, "")
  const loopback = host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host)
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error(`tub: refusing insecure URL ${url}; use https:// (http:// is only allowed for localhost)`)
  }
  return parsed
}

/**
 * RxDB schema for a collection of Tub documents. `data` is the JSON Schema for
 * the document payload, normally the same one registered with `tub schemas add`.
 */
export function tubSchema(options: { version?: number; data?: object; title?: string } = {}): RxJsonSchema<Document> {
  return {
    title: options.title,
    version: options.version ?? 0,
    primaryKey: "id",
    type: "object",
    properties: {
      id: { type: "string", maxLength: MAX_ID_LENGTH },
      type: { type: "string" },
      schema: { type: "string" },
      data: options.data ?? { type: "object" },
      updatedAt: { type: "number" },
    },
    required: ["id", "type", "schema", "data", "updatedAt"],
  } as RxJsonSchema<Document>
}

/** Starts RxDB replication between `collection` and a Tub scope. */
export function replicateTub<T extends Document>(
  opts: TubReplicationOptions<T>,
): RxReplicationState<T, Checkpoint> {
  const base = assertSecureUrl(opts.url).href.replace(/\/$/, "")
  const scope = opts.scope ?? opts.collection.name
  const endpoint = `${base}/replication/${encodeURIComponent(scope)}`
  const doFetch = opts.fetch ?? fetch
  const headers = authHeaders(opts)
  const batchSize = opts.batchSize ?? 100
  const retryTime = opts.retryTime ?? 5000
  const live = opts.live ?? true

  const request = async <R>(path: string, init: RequestInit = {}): Promise<R> => {
    const res = await doFetch(endpoint + path, { ...init, headers: { ...headers, ...init.headers } })
    if (!res.ok) throw new Error(`tub: ${init.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`)
    return (await res.json()) as R
  }

  const stream$ = new Subject<"RESYNC">()
  const stopStream = new AbortController()

  const state = replicateRxCollection<T, Checkpoint>({
    replicationIdentifier: `tub:${base}:${scope}`,
    collection: opts.collection,
    live,
    retryTime,
    autoStart: opts.autoStart,
    pull: {
      batchSize: Math.min(batchSize, MAX_PULL_BATCH),
      handler: (checkpoint, size) =>
        request<PullResponse>(`/pull?seq=${checkpoint?.seq ?? 0}&limit=${size}`) as Promise<{
          documents: T[]
          checkpoint: Checkpoint
        }>,
      stream$: stream$.asObservable(),
    },
    push: {
      batchSize: Math.min(batchSize, MAX_PUSH_BATCH),
      handler: (rows) =>
        request<PushResponse>("/push", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(rows),
        }) as Promise<T[]>,
    },
  })

  if (live) {
    void watch(`${endpoint}/pull/stream`, headers, doFetch, retryTime, stopStream.signal, () => stream$.next("RESYNC"))
    state.onCancel.push(() => {
      stopStream.abort()
      stream$.complete()
    })
  }
  return state
}

/**
 * Follows the server's SSE change notifications, reconnecting after errors.
 * Events only say "something changed"; documents always arrive via pull.
 * The server sends RESYNC on every (re)connect, covering offline gaps.
 */
async function watch(
  url: string,
  headers: Record<string, string>,
  doFetch: typeof fetch,
  retryTime: number,
  signal: AbortSignal,
  onResync: () => void,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const res = await doFetch(url, { headers: { ...headers, accept: "text/event-stream" }, signal })
      if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`)
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ""
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += value.replace(/\r\n?/g, "\n")
        let end
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const event = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          if (event.split("\n").some((line) => line.replace(/^data: ?/, "") === "RESYNC" && line.startsWith("data:"))) {
            onResync()
          }
        }
      }
    } catch {
      // Network error or abort; fall through to retry unless aborted.
    }
    if (signal.aborted) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, retryTime)
      signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true })
    })
  }
}
