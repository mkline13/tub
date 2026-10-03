import type { Database } from "bun:sqlite"
import { afterEach } from "bun:test"
import type { Document } from "@mkline13/tub-shared"
import { openDb } from "../src/db"
import { createCredential } from "../src/db/credentials"
import { SchemaRegistry } from "../src/db/schemas"
import { createScope } from "../src/db/scopes"
import { buildServer } from "../src/server"

export const TASK_SCHEMA = {
  type: "object",
  properties: { title: { type: "string" }, done: { type: "boolean" } },
  required: ["title"],
  additionalProperties: false,
}

const running: { close(): Promise<unknown> }[] = []
afterEach(async () => {
  await Promise.all(running.splice(0).map((app) => app.close()))
})

/**
 * A listening server over a database with scopes `tasks` and `notes`, schema
 * `task.v1`, and three credentials. Tests use real HTTP rather than
 * Fastify's inject(), whose short-circuit behaviour differs under Bun.
 */
export async function fixture(opts: { heartbeatMs?: number } = {}) {
  const db: Database = openDb()
  createScope(db, "tasks")
  createScope(db, "notes")
  new SchemaRegistry(db).add("task.v1", TASK_SCHEMA)
  const both = createCredential(db, "laptop", ["tasks", "notes"])
  const tasksOnly = createCredential(db, "phone", ["tasks"])
  const notesOnly = createCredential(db, "tablet", ["notes"])
  const app = buildServer({ db, heartbeatMs: opts.heartbeatMs })
  const base = await app.listen({ port: 0, host: "127.0.0.1" })
  running.push(app)

  const call = async (method: string, path: string, headers: Record<string, string>, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    const json = (() => JSON.parse(text)) as { (): any; <T>(): T }
    return { status: res.status, headers: res.headers, json }
  }
  const pull = (secret: string, scope: string, query = "") => call("GET", `/replication/${scope}/pull${query}`, auth(secret))
  const push = (secret: string, scope: string, rows: unknown) =>
    call("POST", `/replication/${scope}/push`, auth(secret), rows)

  return { db, app, base, call, pull, push, both, tasksOnly, notesOnly }
}

export const auth = (secret: string) => ({ authorization: `Bearer ${secret}` })

export function task(id: string, title: string, extra: Partial<Document> = {}): Document {
  return { id, type: "task", schema: "task.v1", data: { title }, _deleted: false, updatedAt: 1000, ...extra }
}
