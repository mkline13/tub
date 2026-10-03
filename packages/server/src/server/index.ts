import type { Database } from "bun:sqlite"
import { existsSync, readFileSync } from "node:fs"
import Fastify, { type FastifyReply, type FastifyRequest, type FastifyServerOptions } from "fastify"
import { MAX_PULL_BATCH, SCOPE_NAME_PATTERN, type Credential } from "@mkline13/tub-shared"
import { openDb } from "../db"
import { authenticateSecret, credentialHasScope } from "../db/credentials"
import { parsePushRows, pullDocuments, pushDocuments } from "../db/documents"
import { TubError } from "../db/errors"
import { SchemaRegistry } from "../db/schemas"
import { ScopeNotifier } from "./notifier"

export type ServerOptions = {
  db: Database
  logger?: FastifyServerOptions["logger"]
  https?: { key: Buffer; cert: Buffer }
  /** Interval between SSE heartbeats, which also re-check authorization. */
  heartbeatMs?: number
  bodyLimit?: number
}

const DEFAULT_PULL_LIMIT = 100

function parseBearer(header: string | undefined): string | null {
  const match = header?.match(/^Bearer ([^\s]+)$/)
  return match?.[1] ?? null
}

function parseNonNegativeInt(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback
  if (typeof value !== "string" || !/^\d{1,15}$/.test(value)) return null
  return Number(value)
}

export function buildServer(options: ServerOptions) {
  const { db } = options
  const schemas = new SchemaRegistry(db)
  const notifier = new ScopeNotifier()
  const heartbeatMs = options.heartbeatMs ?? 15_000
  const openStreams = new Set<() => void>()

  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: options.bodyLimit ?? 16 * 1024 * 1024,
    ...(options.https ? { https: options.https } : {}),
  } as FastifyServerOptions)

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof TubError) {
      return reply.code(400).send({ error: error.message, details: error.details })
    }
    const { statusCode, message } = error as { statusCode?: number; message?: string }
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: message })
    }
    request.log.error(error)
    return reply.code(500).send({ error: "internal server error" })
  })

  app.addHook("preClose", async () => {
    for (const close of openStreams) close()
  })

  app.get("/health", async () => ({ ok: true }))

  /**
   * Authenticates the bearer secret and authorizes the scope named in the URL
   * against the credential's grants. The URL scope only selects among
   * already-granted scopes; anything missing, malformed, revoked or ungranted
   * fails closed. Every replication handler calls this first and returns
   * immediately when it yields null (the error response is already sent).
   */
  function authorize(request: FastifyRequest, reply: FastifyReply): { credential: Credential; scope: string } | null {
    const secret = parseBearer(request.headers.authorization)
    const credential = secret ? authenticateSecret(db, secret) : null
    if (!credential) {
      reply.code(401).header("www-authenticate", "Bearer").send({ error: "unauthorized" })
      return null
    }
    const { scope } = request.params as { scope?: string }
    if (!scope || !SCOPE_NAME_PATTERN.test(scope) || !credential.scopes.includes(scope)) {
      reply.code(403).send({ error: "forbidden" })
      return null
    }
    return { credential, scope }
  }

  app.register(
    async (replication) => {
      // Reject early, before the body is parsed. Handlers still call
      // authorize() themselves so they never depend on hook short-circuiting.
      replication.addHook("onRequest", async (request, reply) => {
        if (!authorize(request, reply)) return reply
      })

      replication.get("/:scope/pull", async (request, reply) => {
        const auth = authorize(request, reply)
        if (!auth) return reply
        const { scope } = auth
        const query = request.query as { seq?: unknown; limit?: unknown }
        const seq = parseNonNegativeInt(query.seq, 0)
        const limit = parseNonNegativeInt(query.limit, DEFAULT_PULL_LIMIT)
        if (seq === null || limit === null || limit < 1 || limit > MAX_PULL_BATCH) {
          return reply.code(400).send({ error: `seq must be a non-negative integer and limit 1..${MAX_PULL_BATCH}` })
        }
        return pullDocuments(db, scope, { seq }, limit)
      })

      replication.post("/:scope/push", async (request, reply) => {
        const auth = authorize(request, reply)
        if (!auth) return reply
        const { scope, credential } = auth
        const rows = parsePushRows(schemas, request.body)
        const { conflicts, written } = pushDocuments(db, scope, credential.id, rows)
        if (written > 0) notifier.notify(scope)
        return conflicts
      })

      /**
       * Server-sent events telling the client to re-pull. Carries no document
       * data: the client pulls through the normal authorized endpoint.
       * Authorization is re-checked on every event and heartbeat, so a revoked
       * credential's stream is closed promptly.
       */
      replication.get("/:scope/pull/stream", (request, reply) => {
        const auth = authorize(request, reply)
        if (!auth) return reply
        const { scope } = auth
        const credentialId = auth.credential.id
        reply.hijack()
        const res = reply.raw
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        })

        let closed = false
        const close = () => {
          if (closed) return
          closed = true
          clearInterval(heartbeat)
          unsubscribe()
          openStreams.delete(close)
          res.end()
        }
        const send = (chunk: string) => {
          if (closed) return
          if (!credentialHasScope(db, credentialId, scope)) return close()
          res.write(chunk)
        }

        const unsubscribe = notifier.subscribe(scope, () => send("data: RESYNC\n\n"))
        const heartbeat = setInterval(() => send(": ping\n\n"), heartbeatMs)
        openStreams.add(close)
        request.raw.on("close", close)
        // A fresh connection may have missed changes, so start with a resync.
        send("retry: 5000\ndata: RESYNC\n\n")
      })
    },
    { prefix: "/replication" },
  )

  return app
}

export type ServeConfig = {
  dbPath: string
  host: string
  port: number
  tlsCert?: string
  tlsKey?: string
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"])

export function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || /^127\.\d+\.\d+\.\d+$/.test(host)
}

/**
 * Starts the server. Plain HTTP is only allowed on loopback (for local use,
 * or behind a TLS-terminating reverse proxy on the same host); binding any
 * other address requires a TLS certificate and key.
 */
export async function serve(config: ServeConfig) {
  if (!existsSync(config.dbPath)) {
    throw new TubError(`no database at ${config.dbPath}; run 'tub init' first`)
  }
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new TubError(`invalid port '${config.port}'`)
  }
  if (!!config.tlsCert !== !!config.tlsKey) {
    throw new TubError("TLS needs both a certificate and a key")
  }
  if (!config.tlsCert && !isLoopback(config.host)) {
    throw new TubError(
      `refusing to serve plain HTTP on ${config.host}: TLS is required for remote connections. ` +
        "Provide --tls-cert and --tls-key, or bind to 127.0.0.1 behind a TLS-terminating reverse proxy.",
    )
  }
  const https =
    config.tlsCert && config.tlsKey
      ? { cert: readFileSync(config.tlsCert), key: readFileSync(config.tlsKey) }
      : undefined
  const app = buildServer({ db: openDb(config.dbPath), logger: { level: "info" }, https })
  await app.listen({ host: config.host, port: config.port })
  return app
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): ServeConfig {
  return {
    dbPath: env.TUB_DB ?? "tub.db",
    host: env.TUB_HOST ?? "127.0.0.1",
    port: Number(env.TUB_PORT ?? env.PORT ?? 8787),
    tlsCert: env.TUB_TLS_CERT,
    tlsKey: env.TUB_TLS_KEY,
  }
}

if (import.meta.main) {
  await serve(configFromEnv())
}
