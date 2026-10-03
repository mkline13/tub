import { afterEach, describe, expect, test } from "bun:test"
import type { Document } from "@mkline13/tub-shared"
import { openDb } from "@mkline13/tub-server/src/db"
import { createCredential, revokeCredential } from "@mkline13/tub-server/src/db/credentials"
import { SchemaRegistry } from "@mkline13/tub-server/src/db/schemas"
import { createScope } from "@mkline13/tub-server/src/db/scopes"
import { buildServer } from "@mkline13/tub-server/src/server"
import { createRxDatabase, type RxCollection, type RxDatabase } from "rxdb"
import { getRxStorageMemory } from "rxdb/plugins/storage-memory"
import { firstValueFrom } from "rxjs"
import { filter } from "rxjs/operators"
import { assertSecureUrl, authHeaders, replicateTub, tubSchema } from "../src"

const TASK = { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false }

test("authHeaders builds a bearer header", () => {
  expect(authHeaders({ url: "http://x", secret: "s" })).toEqual({ authorization: "Bearer s" })
})

test("assertSecureUrl requires https except for loopback", () => {
  for (const ok of ["https://tub.example.com", "http://localhost:8787", "http://127.0.0.1:1", "http://[::1]:2"]) {
    expect(() => assertSecureUrl(ok)).not.toThrow()
  }
  for (const bad of ["http://tub.example.com", "http://10.0.0.2", "ftp://localhost"]) {
    expect(() => assertSecureUrl(bad)).toThrow(/insecure/)
  }
})

test("tubSchema describes the Tub document shape", () => {
  const schema = tubSchema({ version: 2, data: TASK })
  expect(schema.primaryKey).toBe("id")
  expect(schema.version).toBe(2)
  expect(schema.properties.data).toEqual(TASK)
  expect(schema.required).toEqual(["id", "type", "schema", "data", "updatedAt"])
})

describe("replication against a real Tub server", () => {
  const cleanup: (() => Promise<unknown>)[] = []
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn()
  })

  async function server() {
    const db = openDb()
    createScope(db, "tasks")
    createScope(db, "notes")
    new SchemaRegistry(db).add("task.v1", TASK)
    const app = buildServer({ db })
    const url = await app.listen({ port: 0, host: "127.0.0.1" })
    cleanup.push(() => app.close())
    return { db, url }
  }

  let dbCount = 0
  async function client(url: string, secret: string, collectionName = "tasks") {
    const rxdb: RxDatabase = await createRxDatabase({ name: `client${dbCount++}`, storage: getRxStorageMemory() })
    cleanup.push(() => rxdb.remove())
    const { [collectionName]: collection } = await rxdb.addCollections({ [collectionName]: { schema: tubSchema({ data: TASK }) } })
    const replication = replicateTub({ url, secret, collection: collection as RxCollection<Document>, retryTime: 50 })
    cleanup.push(() => replication.cancel())
    return { collection: collection as RxCollection<Document>, replication }
  }

  const write = (c: RxCollection<Document>, id: string, title: string) =>
    c.upsert({ id, type: "task", schema: "task.v1", data: { title }, updatedAt: Date.now() })

  const waitFor = async (check: () => Promise<boolean>, ms = 5000) => {
    const deadline = Date.now() + ms
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error("timed out")
      await Bun.sleep(20)
    }
  }

  const title = async (c: RxCollection<Document>, id: string) =>
    ((await c.findOne(id).exec())?.toJSON().data as { title?: string } | undefined)?.title

  test("changes, updates and deletions flow between two devices through the live stream", async () => {
    const { db, url } = await server()
    const { secret } = createCredential(db, "laptop", ["tasks"])
    const a = await client(url, secret)
    const b = await client(url, secret)
    await a.replication.awaitInitialReplication()
    await b.replication.awaitInitialReplication()

    await write(a.collection, "t1", "buy milk")
    await waitFor(async () => (await title(b.collection, "t1")) === "buy milk")

    await write(b.collection, "t1", "buy oat milk")
    await waitFor(async () => (await title(a.collection, "t1")) === "buy oat milk")

    await (await a.collection.findOne("t1").exec())!.remove()
    await waitFor(async () => (await b.collection.findOne("t1").exec()) === null)
    const stored = db.query("SELECT deleted FROM documents WHERE id = 't1'").get()
    expect(stored).toEqual({ deleted: 1 })
  })

  test("offline writes are kept locally and sync when the device reconnects", async () => {
    const { db, url } = await server()
    const { secret } = createCredential(db, "laptop", ["tasks"])
    const a = await client(url, secret)
    const b = await client(url, secret)
    await a.replication.awaitInitialReplication()
    await b.replication.awaitInitialReplication()

    await a.replication.pause()
    await write(a.collection, "t2", "written offline")
    expect(await title(a.collection, "t2")).toBe("written offline")
    await Bun.sleep(100)
    expect(await title(b.collection, "t2")).toBeUndefined()

    await a.replication.start()
    await waitFor(async () => (await title(b.collection, "t2")) === "written offline")
  })

  test("concurrent offline edits surface as a conflict resolved by RxDB's conflict handler", async () => {
    const { db, url } = await server()
    const { secret } = createCredential(db, "laptop", ["tasks"])
    const a = await client(url, secret)
    const b = await client(url, secret)
    await write(a.collection, "t4", "original")
    await waitFor(async () => (await title(b.collection, "t4")) === "original")

    await a.replication.pause()
    await write(b.collection, "t4", "edited on b")
    await b.replication.awaitInSync()
    await write(a.collection, "t4", "edited on a while offline")
    await a.replication.start()

    // RxDB's default handler keeps the server state; Tub never overwrote it.
    await waitFor(async () => (await title(a.collection, "t4")) === "edited on b")
    await a.replication.awaitInSync()
    expect(await title(b.collection, "t4")).toBe("edited on b")
    const changes = db.query("SELECT count(*) AS n FROM changes WHERE doc_id = 't4'").get()
    expect(changes).toEqual({ n: 2 })
  })

  test("a credential cannot sync a scope it was not granted", async () => {
    const { db, url } = await server()
    const { secret: notesSecret } = createCredential(db, "phone", ["notes"])
    const { secret: tasksSecret } = createCredential(db, "laptop", ["tasks"])
    const owner = await client(url, tasksSecret)
    await owner.replication.awaitInitialReplication()
    await write(owner.collection, "private", "tasks only")
    await owner.replication.awaitInSync()

    const intruder = await client(url, notesSecret, "tasks")
    const error = await firstValueFrom(intruder.replication.error$)
    expect(JSON.stringify(error.parameters.errors)).toContain("403")
    expect(await intruder.collection.find().exec()).toEqual([])
  })

  test("documents that fail schema validation are rejected and reported", async () => {
    const { db, url } = await server()
    const { secret } = createCredential(db, "laptop", ["tasks"])
    const a = await client(url, secret)
    await a.replication.awaitInitialReplication()
    await a.collection.insert({ id: "bad", type: "task", schema: "task.v1", data: { nope: true }, _deleted: false, updatedAt: 1 })
    const error = await firstValueFrom(a.replication.error$.pipe(filter((e) => e.code === "RC_PUSH")))
    expect(JSON.stringify(error.parameters.errors)).toContain("400")
    expect(db.query("SELECT count(*) AS n FROM documents").get()).toEqual({ n: 0 })
  })

  test("revoking a credential stops synchronization", async () => {
    const { db, url } = await server()
    const { secret } = createCredential(db, "laptop", ["tasks"])
    const a = await client(url, secret)
    await a.replication.awaitInitialReplication()
    revokeCredential(db, "laptop")
    await write(a.collection, "t3", "after revoke")
    const error = await firstValueFrom(a.replication.error$)
    expect(JSON.stringify(error.parameters.errors)).toContain("401")
    expect(db.query("SELECT count(*) AS n FROM documents").get()).toEqual({ n: 0 })
  })
})
