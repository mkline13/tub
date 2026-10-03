import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCli } from "../src/cli"
import { openDb } from "../src/db"
import { authenticateSecret } from "../src/db/credentials"
import { TASK_SCHEMA } from "./helpers"

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "tub-cli-"))
  const db = join(dir, "tub.db")
  const tub = async (...args: string[]) => {
    const out: string[] = []
    const err: string[] = []
    const code = await runCli(["--db", db, ...args], { out: (l) => out.push(l), err: (l) => err.push(l) }, {})
    return { code, out: out.join("\n"), err: err.join("\n") }
  }
  return { dir, db, tub }
}

describe("tub CLI", () => {
  test("commands other than init require an initialized database", async () => {
    const { tub } = setup()
    const res = await tub("scopes", "list")
    expect(res.code).toBe(1)
    expect(res.err).toContain("run 'tub init' first")
  })

  test("init is idempotent", async () => {
    const { tub } = setup()
    expect((await tub("init")).out).toContain("created database")
    expect((await tub("init")).out).toContain("up to date")
  })

  test("scopes", async () => {
    const { tub } = setup()
    await tub("init")
    expect((await tub("scopes", "list")).out).toBe("no scopes")
    expect((await tub("scopes", "create", "personal")).code).toBe(0)
    expect((await tub("scopes", "create", "personal")).err).toContain("already exists")
    expect((await tub("scopes", "create", "Not Valid")).code).toBe(1)
    expect((await tub("scopes", "list")).out).toContain("personal")
  })

  test("credentials: create prints a working secret once, revoke disables it", async () => {
    const { tub, db } = setup()
    await tub("init")
    await tub("scopes", "create", "personal")
    await tub("scopes", "create", "projects")

    expect((await tub("credentials", "create", "laptop")).err).toContain("at least one scope")
    expect((await tub("credentials", "create", "laptop", "--scope", "missing")).err).toContain("does not exist")

    const created = await tub("credentials", "create", "laptop", "--scope", "personal", "--scope", "projects")
    expect(created.code).toBe(0)
    const secret = created.out.split("\n").at(-1)!
    expect(secret).toStartWith("tub_")
    expect((await tub("credentials", "create", "laptop", "--scope", "personal")).err).toContain("already exists")

    const conn = openDb(db)
    expect(authenticateSecret(conn, secret)?.scopes).toEqual(["personal", "projects"])
    const listed = (await tub("credentials", "list")).out
    expect(listed).toContain("personal,projects")
    expect(listed).not.toContain(secret)

    expect((await tub("credentials", "revoke", "laptop")).code).toBe(0)
    expect(authenticateSecret(conn, secret)).toBeNull()
    expect((await tub("credentials", "list")).out).toContain("revoked")
    expect((await tub("credentials", "revoke", "laptop")).err).toContain("no active credential")
    // The name can be reused after revocation.
    expect((await tub("credentials", "create", "laptop", "--scope", "personal")).code).toBe(0)
    conn.close()
  })

  test("schemas: add, list, show; invalid and duplicate schemas are rejected", async () => {
    const { tub, dir } = setup()
    await tub("init")
    const file = join(dir, "task.json")
    writeFileSync(file, JSON.stringify(TASK_SCHEMA))
    expect((await tub("schemas", "add", "task.v1", file)).code).toBe(0)
    expect((await tub("schemas", "add", "task.v1", file)).err).toContain("immutable")
    expect(JSON.parse((await tub("schemas", "show", "task.v1")).out)).toEqual(TASK_SCHEMA)
    expect((await tub("schemas", "list")).out).toContain("task.v1")

    const bad = join(dir, "bad.json")
    writeFileSync(bad, JSON.stringify({ type: "nonsense" }))
    expect((await tub("schemas", "add", "bad.v1", bad)).err).toContain("invalid JSON Schema")
    expect((await tub("schemas", "add", "x.v1", join(dir, "missing.json"))).err).toContain("cannot read")
  })

  test("backup writes a consistent copy and refuses to overwrite", async () => {
    const { tub, dir } = setup()
    await tub("init")
    await tub("scopes", "create", "personal")
    const dest = join(dir, "backup.db")
    expect((await tub("backup", dest)).code).toBe(0)
    expect(existsSync(dest)).toBe(true)
    const copy = openDb(dest)
    expect(copy.query("SELECT name FROM scopes").all()).toEqual([{ name: "personal" }])
    copy.close()
    expect((await tub("backup", dest)).err).toContain("already exists")
  })

  test("usage errors exit 2", async () => {
    const { tub } = setup()
    expect((await tub()).code).toBe(2)
    expect((await tub("frobnicate")).code).toBe(2)
    expect((await tub("scopes", "create")).code).toBe(2)
    expect((await tub("--nope")).code).toBe(2)
    expect((await tub("--help")).code).toBe(0)
  })
})

test("migrations are idempotent across reopen", () => {
  const path = join(mkdtempSync(join(tmpdir(), "tub-db-")), "tub.db")
  openDb(path).close()
  const db = openDb(path)
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 })
  db.close()
})
