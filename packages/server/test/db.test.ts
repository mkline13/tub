import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDb } from "../src/db"

test("processes opening a new database at the same time migrate it once", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "tub-db-")), "tub.db")
  const script = `import { openDb } from ${JSON.stringify(join(import.meta.dir, "../src/db"))}; openDb(${JSON.stringify(dbPath)}).close()`
  const procs = Array.from({ length: 8 }, () => Bun.spawn(["bun", "-e", script], { stderr: "pipe" }))
  const results = await Promise.all(procs.map(async (p) => ({ code: await p.exited, err: await new Response(p.stderr).text() })))
  for (const r of results) expect(r).toEqual({ code: 0, err: "" })
  const db = openDb(dbPath)
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 })
  db.close()
})
