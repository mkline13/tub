import { describe, expect, test } from "bun:test"
import type { Document, PullResponse } from "@mkline13/tub-shared"
import { mkdtempSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { openDb } from "../src/db"
import { revokeCredential } from "../src/db/credentials"
import { configFromEnv, isLoopback, serve } from "../src/server"
import { auth, fixture, task } from "./helpers"

test("health endpoint responds without auth", async () => {
  const { call } = await fixture()
  const res = await call("GET", "/health", {})
  expect(res.status).toBe(200)
  expect(res.json()).toEqual({ ok: true })
})

describe("authentication", () => {
  test.each([
    ["missing", undefined],
    ["not bearer", "Basic abc"],
    ["unknown secret", "Bearer tub_nope"],
    ["no prefix", "Bearer whatever"],
    ["empty bearer", "Bearer "],
  ])("rejects %s credentials with 401", async (_name, header) => {
    const { call, db } = await fixture()
    const headers: Record<string, string> = header === undefined ? {} : { authorization: header }
    for (const [method, url] of [
      ["GET", "/replication/tasks/pull"],
      ["POST", "/replication/tasks/push"],
      ["GET", "/replication/tasks/pull/stream"],
    ] as const) {
      const res = await call(method, url, headers, method === "POST" ? [{ newDocumentState: task("a", "x") }] : undefined)
      expect(res.status).toBe(401)
      expect(res.headers.get("www-authenticate")).toBe("Bearer")
    }
    expect(db.query("SELECT count(*) AS n FROM changes").get()).toEqual({ n: 0 })
  })

  test("revocation takes effect on the next request", async () => {
    const { db, both, pull, push } = await fixture()
    expect((await pull(both.secret, "tasks")).status).toBe(200)
    revokeCredential(db, "laptop")
    expect((await pull(both.secret, "tasks")).status).toBe(401)
    expect((await push(both.secret, "tasks", [])).status).toBe(401)
  })

  test("records lastUsedAt", async () => {
    const { db, tasksOnly, pull, push } = await fixture()
    await pull(tasksOnly.secret, "tasks")
    const row = db.query("SELECT last_used_at AS t FROM credentials WHERE name = 'phone'").get() as { t: number }
    expect(row.t).toBeGreaterThan(0)
  })

  test("secrets are stored only as hashes", async () => {
    const { db, both, tasksOnly } = await fixture()
    const dump = JSON.stringify(db.query("SELECT * FROM credentials").all())
    expect(dump).not.toContain(both.secret)
    expect(dump).not.toContain(tasksOnly.secret.slice(4))
  })
})

describe("scope authorization", () => {
  test("pull, push and stream reject scopes the credential was not granted", async () => {
    const { call, pull, push, tasksOnly } = await fixture()
    expect((await pull(tasksOnly.secret, "notes")).status).toBe(403)
    expect((await push(tasksOnly.secret, "notes", [{ newDocumentState: task("n1", "x") }])).status).toBe(403)
    const stream = await call("GET", "/replication/notes/pull/stream", auth(tasksOnly.secret))
    expect(stream.status).toBe(403)
  })

  test("nonexistent and malformed scope names get the same 403", async () => {
    const { both, pull, push } = await fixture()
    for (const scope of ["nope", "TASKS", "tasks%00", "..%2Ftasks", "tasks,notes"]) {
      expect((await pull(both.secret, scope)).status).toBe(403)
    }
  })

  test("documents with the same id in different scopes stay separate", async () => {
    const { both, tasksOnly, pull, push } = await fixture()
    await push(both.secret, "tasks", [{ newDocumentState: task("same", "task copy") }])
    await push(both.secret, "notes", [{ newDocumentState: task("same", "secret note") }])

    const tasks = (await pull(tasksOnly.secret, "tasks")).json<PullResponse>()
    expect(tasks.documents.map((d) => (d.data as { title: string }).title)).toEqual(["task copy"])
    // A tasks-only credential overwriting "same" in tasks must not touch notes.
    await push(tasksOnly.secret, "tasks", [
      { assumedMasterState: tasks.documents[0], newDocumentState: task("same", "edited", { updatedAt: 2000 }) },
    ])
    const notes = (await pull(both.secret, "notes")).json<PullResponse>()
    expect(notes.documents.map((d) => (d.data as { title: string }).title)).toEqual(["secret note"])
  })

  test("a scope field inside the document cannot redirect a write", async () => {
    const { tasksOnly, pull, push } = await fixture()
    const res = await push(tasksOnly.secret, "tasks", [{ newDocumentState: { ...task("a", "x"), scope: "notes" } }])
    expect(res.status).toBe(400)
  })
})

describe("push validation", () => {
  test.each([
    ["not an array", { newDocumentState: task("a", "x") }],
    ["missing newDocumentState", [{}]],
    ["missing field", [{ newDocumentState: { id: "a", type: "task", schema: "task.v1", data: {}, _deleted: false } }]],
    ["empty id", [{ newDocumentState: task("", "x") }]],
    ["wrong field type", [{ newDocumentState: { ...task("a", "x"), _deleted: "no" } }]],
    ["unknown schema", [{ newDocumentState: task("a", "x", { schema: "nope.v1" }) }]],
    ["data not matching schema", [{ newDocumentState: task("a", "x", { data: { title: 5 } }) }]],
    ["extra data property", [{ newDocumentState: task("a", "x", { data: { title: "x", extra: 1 } }) }]],
  ])("rejects %s with 400 and writes nothing", async (_name, body) => {
    const { db, both, pull, push } = await fixture()
    const res = await push(both.secret, "tasks", body)
    expect(res.status).toBe(400)
    expect(res.json<{ error: string }>().error).toBeString()
    expect(db.query("SELECT count(*) AS n FROM documents").get()).toEqual({ n: 0 })
  })

  test("one invalid row rejects the whole batch", async () => {
    const { db, both, pull, push } = await fixture()
    const res = await push(both.secret, "tasks", [
      { newDocumentState: task("good", "fine") },
      { newDocumentState: task("bad", "x", { data: {} }) },
    ])
    expect(res.status).toBe(400)
    expect(res.json<{ details: { index: number; id: string }[] }>().details).toMatchObject([{ index: 1, id: "bad" }])
    expect(db.query("SELECT count(*) AS n FROM documents").get()).toEqual({ n: 0 })
  })

  test("tombstones are validated too", async () => {
    const { both, pull, push } = await fixture()
    const res = await push(both.secret, "tasks", [{ newDocumentState: task("a", "x", { _deleted: true, data: {} }) }])
    expect(res.status).toBe(400)
  })

  test("RxDB-local fields are stripped before validation and storage", async () => {
    const { both, pull, push } = await fixture()
    const local = { ...task("a", "x"), _meta: { lwt: 1 }, _rev: "1-abc", _attachments: {} }
    expect((await push(both.secret, "tasks", [{ newDocumentState: local }])).json()).toEqual([])
    const { documents } = (await pull(both.secret, "tasks")).json<PullResponse>()
    expect(documents).toEqual([task("a", "x")])
  })
})

describe("replication", () => {
  test("pull pages through changes with a server-assigned checkpoint", async () => {
    const { both, pull, push } = await fixture()
    const rows = ["c", "a", "b"].map((id) => ({ newDocumentState: task(id, id, { updatedAt: 5 }) }))
    expect((await push(both.secret, "tasks", rows)).json()).toEqual([])

    const first = (await pull(both.secret, "tasks", "?limit=2")).json<PullResponse>()
    expect(first.documents.map((d) => d.id)).toEqual(["c", "a"])
    const second = (await pull(both.secret, "tasks", `?seq=${first.checkpoint.seq}&limit=2`)).json<PullResponse>()
    expect(second.documents.map((d) => d.id)).toEqual(["b"])
    const done = (await pull(both.secret, "tasks", `?seq=${second.checkpoint.seq}`)).json<PullResponse>()
    expect(done).toEqual({ documents: [], checkpoint: second.checkpoint })
  })

  test("an updated document moves to the end of the change order", async () => {
    const { both, pull, push } = await fixture()
    await push(both.secret, "tasks", [{ newDocumentState: task("a", "1") }, { newDocumentState: task("b", "1") }])
    const before = (await pull(both.secret, "tasks")).json<PullResponse>()
    await push(both.secret, "tasks", [{ assumedMasterState: before.documents[0], newDocumentState: task("a", "2") }])
    const after = (await pull(both.secret, "tasks", `?seq=${before.checkpoint.seq}`)).json<PullResponse>()
    expect(after.documents).toEqual([task("a", "2")])
  })

  test("rejects bad pull parameters", async () => {
    const { both, pull, push } = await fixture()
    for (const q of ["?seq=-1", "?seq=abc", "?limit=0", "?limit=1001", "?seq=1.5"]) {
      expect((await pull(both.secret, "tasks", q)).status).toBe(400)
    }
  })

  test("deletions replicate as tombstones", async () => {
    const { both, pull, push } = await fixture()
    await push(both.secret, "tasks", [{ newDocumentState: task("a", "x") }])
    const deleted = task("a", "x", { _deleted: true, updatedAt: 2000 })
    await push(both.secret, "tasks", [{ assumedMasterState: task("a", "x"), newDocumentState: deleted }])
    expect((await pull(both.secret, "tasks")).json<PullResponse>().documents).toEqual([deleted])
  })

  test("every accepted write is recorded in the change history", async () => {
    const { db, both, pull, push } = await fixture()
    await push(both.secret, "tasks", [{ newDocumentState: task("a", "1") }])
    await push(both.secret, "tasks", [{ assumedMasterState: task("a", "1"), newDocumentState: task("a", "2") }])
    await push(both.secret, "tasks", [{ newDocumentState: task("a", "conflict") }])
    const changes = db.query("SELECT doc_id AS id, credential_id AS cred FROM changes ORDER BY seq").all()
    expect(changes).toEqual([
      { id: "a", cred: both.credential.id },
      { id: "a", cred: both.credential.id },
    ])
  })
})

describe("conflicts", () => {
  test("creating a document that already exists returns the server state", async () => {
    const { both, pull, push } = await fixture()
    await push(both.secret, "tasks", [{ newDocumentState: task("a", "server") }])
    const res = await push(both.secret, "tasks", [{ newDocumentState: task("a", "client") }])
    expect(res.json()).toEqual([task("a", "server")])
  })

  test("a stale assumed state conflicts and does not overwrite", async () => {
    const { both, pull, push } = await fixture()
    await push(both.secret, "tasks", [{ newDocumentState: task("a", "v1") }])
    await push(both.secret, "tasks", [{ assumedMasterState: task("a", "v1"), newDocumentState: task("a", "v2") }])
    const res = await push(both.secret, "tasks", [
      { assumedMasterState: task("a", "v1"), newDocumentState: task("a", "v3") },
    ])
    expect(res.json()).toEqual([task("a", "v2")])
    expect((await pull(both.secret, "tasks")).json<PullResponse>().documents).toEqual([task("a", "v2")])
  })

  test("key order does not cause false conflicts", async () => {
    const { both, pull, push } = await fixture()
    await push(both.secret, "tasks", [{ newDocumentState: task("a", "v1", { data: { title: "v1", done: false } }) }])
    const reordered: Document = {
      updatedAt: 1000,
      _deleted: false,
      data: { done: false, title: "v1" },
      schema: "task.v1",
      type: "task",
      id: "a",
    }
    const res = await push(both.secret, "tasks", [{ assumedMasterState: reordered, newDocumentState: task("a", "v2") }])
    expect(res.json()).toEqual([])
  })

  test("non-conflicting rows in a batch are written alongside conflicts", async () => {
    const { both, pull, push } = await fixture()
    await push(both.secret, "tasks", [{ newDocumentState: task("a", "server") }])
    const res = await push(both.secret, "tasks", [
      { newDocumentState: task("a", "client") },
      { newDocumentState: task("b", "new") },
    ])
    expect(res.json()).toEqual([task("a", "server")])
    expect((await pull(both.secret, "tasks")).json<PullResponse>().documents.map((d) => d.id)).toEqual(["a", "b"])
  })
})

describe("live stream", () => {
  async function openStream(base: string, secret: string, scope = "tasks") {
    const controller = new AbortController()
    const res = await fetch(`${base}/replication/${scope}/pull/stream`, { headers: auth(secret), signal: controller.signal })
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ""
    const next = async (): Promise<string | null> => {
      for (;;) {
        const end = buffer.indexOf("\n\n")
        if (end !== -1) {
          const event = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          return event
        }
        const { value, done } = await reader.read()
        if (done) return null
        buffer += value
      }
    }
    return { res, next, close: () => controller.abort() }
  }

  test("sends RESYNC on connect and after each write to the scope only", async () => {
    const { base, both, push } = await fixture()
    {
      const tasks = await openStream(base, both.secret, "tasks")
      expect(tasks.res.headers.get("content-type")).toBe("text/event-stream")
      expect(await tasks.next()).toBe("retry: 5000\ndata: RESYNC")

      await push(both.secret, "notes", [{ newDocumentState: task("n", "note") }])
      await push(both.secret, "tasks", [{ newDocumentState: task("t", "task") }])
      // The notes write must not have produced an event; the first one is for tasks.
      expect(await tasks.next()).toBe("data: RESYNC")
      tasks.close()
    }
  })

  test("closes the stream once the credential is revoked", async () => {
    const { base, db, both } = await fixture({ heartbeatMs: 20 })
    {
      const stream = await openStream(base, both.secret)
      expect(await stream.next()).toBe("retry: 5000\ndata: RESYNC")
      expect(await stream.next()).toBe(": ping")
      revokeCredential(db, "laptop")
      let event
      do event = await stream.next()
      while (event === ": ping")
      expect(event).toBeNull()
    }
  })
})

describe("serve", () => {
  test("loopback detection", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "::1", "localhost"]) expect(isLoopback(host)).toBe(true)
    for (const host of ["0.0.0.0", "::", "192.168.1.5", "example.com"]) expect(isLoopback(host)).toBe(false)
  })

  const tempDb = () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "tub-")), "tub.db")
    openDb(dbPath).close()
    return dbPath
  }

  test("refuses plain HTTP on a non-loopback address", async () => {
    const dbPath = tempDb()
    await expect(serve({ dbPath, host: "0.0.0.0", port: 0 })).rejects.toThrow(/TLS is required/)
    await expect(serve({ dbPath, host: "127.0.0.1", port: 0, tlsCert: "x" })).rejects.toThrow(/both a certificate and a key/)
  })

  test("serves plain HTTP on a non-loopback address only with the behind-proxy opt-in", async () => {
    const dbPath = tempDb()
    const app = await serve({ dbPath, host: "0.0.0.0", port: 0, behindProxy: true })
    try {
      const { port } = app.server.address() as AddressInfo
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      expect(await res.json()).toEqual({ ok: true })
    } finally {
      await app.close()
    }
  })

  test("TUB_BEHIND_PROXY is off by default and fails closed on unknown values", () => {
    expect(configFromEnv({}).behindProxy).toBe(false)
    for (const v of ["", "0", "false"]) expect(configFromEnv({ TUB_BEHIND_PROXY: v }).behindProxy).toBe(false)
    for (const v of ["1", "true"]) expect(configFromEnv({ TUB_BEHIND_PROXY: v }).behindProxy).toBe(true)
    for (const v of ["yes", "on", "TRUE"]) expect(() => configFromEnv({ TUB_BEHIND_PROXY: v })).toThrow(/TUB_BEHIND_PROXY/)
  })

  test("refuses to start without an initialized database", async () => {
    await expect(serve({ dbPath: "/nonexistent/tub.db", host: "127.0.0.1", port: 0 })).rejects.toThrow(/tub init/)
  })

  test.skipIf(!Bun.which("openssl"))("serves HTTPS on any address when given a certificate", async () => {
    const dbPath = tempDb()
    const dir = dirname(dbPath)
    const gen = Bun.spawnSync(
      ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
       "-keyout", `${dir}/key.pem`, "-out", `${dir}/cert.pem`],
      { stderr: "pipe" },
    )
    expect(gen.exitCode).toBe(0)
    const app = await serve({ dbPath, host: "0.0.0.0", port: 0, tlsCert: `${dir}/cert.pem`, tlsKey: `${dir}/key.pem` })
    try {
      const { port } = app.server.address() as AddressInfo
      const res = await fetch(`https://127.0.0.1:${port}/health`, { tls: { rejectUnauthorized: false } })
      expect(await res.json()).toEqual({ ok: true })
    } finally {
      await app.close()
    }
  })
})
