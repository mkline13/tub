#!/usr/bin/env bun
// `tub` admin CLI: local, terminal-based administration (see SPEC.md section 11).
import type { Database } from "bun:sqlite"
import { existsSync, readFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { openDb } from "../db"
import { createCredential, listCredentials, revokeCredential } from "../db/credentials"
import { TubError } from "../db/errors"
import { SchemaRegistry } from "../db/schemas"
import { createScope, listScopes } from "../db/scopes"
import { configFromEnv, serve } from "../server"

export const USAGE = `usage: tub [--db <path>] <command>

commands:
  init                                     create (or migrate) the database
  serve [--host H] [--port P] [--tls-cert F --tls-key F]
                                           run the sync server
  scopes list
  scopes create <name>
  credentials list
  credentials create <name> --scope <s> [--scope <s>...]
                                           prints the secret once
  credentials revoke <name>
  schemas list
  schemas add <id> <file.json>             add a JSON Schema (immutable)
  schemas show <id>
  backup [<path>]                          consistent copy of the database

The database path is --db, else $TUB_DB, else ./tub.db.
serve also reads $TUB_HOST, $TUB_PORT, $TUB_TLS_CERT and $TUB_TLS_KEY.`

export type Io = { out: (line: string) => void; err: (line: string) => void }

const consoleIo: Io = { out: (l) => console.log(l), err: (l) => console.error(l) }

const iso = (ms: number | undefined) => (ms === undefined ? "-" : new Date(ms).toISOString())

function table(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)))
  return rows.map((r) => r.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd())
}

function defaultBackupPath(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")
  return `tub-backup-${stamp}.db`
}

/** Runs the CLI and returns the process exit code. `serve` resolves once listening. */
export async function runCli(argv: string[], io: Io = consoleIo, env = process.env): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        db: { type: "string" },
        scope: { type: "string", multiple: true },
        host: { type: "string" },
        port: { type: "string" },
        "tls-cert": { type: "string" },
        "tls-key": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    })
  } catch (err) {
    io.err(`tub: ${(err as Error).message}`)
    io.err(USAGE)
    return 2
  }
  const { values, positionals } = parsed
  const [command, sub, ...rest] = positionals
  if (values.help || !command) {
    io.out(USAGE)
    return values.help ? 0 : 2
  }

  const dbPath = values.db ?? env.TUB_DB ?? "tub.db"
  const withDb = <T>(fn: (db: Database) => T): T => {
    if (!existsSync(dbPath)) throw new TubError(`no database at ${dbPath}; run 'tub init' first`)
    const db = openDb(dbPath)
    try {
      return fn(db)
    } finally {
      db.close()
    }
  }
  const usageError = () => {
    io.err(USAGE)
    return 2
  }

  try {
    switch (command) {
      case "init": {
        const existed = existsSync(dbPath)
        openDb(dbPath).close()
        io.out(existed ? `database at ${dbPath} is up to date` : `created database at ${dbPath}`)
        return 0
      }

      case "serve": {
        const config = configFromEnv({ ...env, TUB_DB: dbPath })
        if (values.host) config.host = values.host
        if (values.port) config.port = Number(values.port)
        if (values["tls-cert"]) config.tlsCert = values["tls-cert"]
        if (values["tls-key"]) config.tlsKey = values["tls-key"]
        await serve(config)
        return 0
      }

      case "scopes":
        if (sub === "list" && rest.length === 0) {
          return withDb((db) => {
            const scopes = listScopes(db)
            if (scopes.length === 0) io.out("no scopes")
            else table([["NAME", "CREATED"], ...scopes.map((s) => [s.name, iso(s.createdAt)])]).forEach(io.out)
            return 0
          })
        }
        if (sub === "create" && rest.length === 1) {
          return withDb((db) => {
            io.out(`created scope ${createScope(db, rest[0]!).name}`)
            return 0
          })
        }
        return usageError()

      case "credentials":
        if (sub === "list" && rest.length === 0) {
          return withDb((db) => {
            const creds = listCredentials(db)
            if (creds.length === 0) io.out("no credentials")
            else
              table([
                ["NAME", "STATUS", "SCOPES", "CREATED", "LAST USED"],
                ...creds.map((c) => [
                  c.name,
                  c.revokedAt === undefined ? "active" : "revoked",
                  c.scopes.join(","),
                  iso(c.createdAt),
                  iso(c.lastUsedAt),
                ]),
              ]).forEach(io.out)
            return 0
          })
        }
        if (sub === "create" && rest.length === 1) {
          return withDb((db) => {
            const { credential, secret } = createCredential(db, rest[0]!, values.scope ?? [])
            io.out(`created credential ${credential.name} for scopes: ${credential.scopes.join(", ")}`)
            io.out("secret (shown once, store it now):")
            io.out(secret)
            return 0
          })
        }
        if (sub === "revoke" && rest.length === 1) {
          return withDb((db) => {
            io.out(`revoked credential ${revokeCredential(db, rest[0]!).name}`)
            return 0
          })
        }
        return usageError()

      case "schemas":
        if (sub === "list" && rest.length === 0) {
          return withDb((db) => {
            const schemas = new SchemaRegistry(db).list()
            if (schemas.length === 0) io.out("no schemas")
            else table([["ID", "CREATED"], ...schemas.map((s) => [s.id, iso(s.createdAt)])]).forEach(io.out)
            return 0
          })
        }
        if (sub === "add" && rest.length === 2) {
          const [id, file] = rest as [string, string]
          let definition: unknown
          try {
            definition = JSON.parse(readFileSync(file, "utf8"))
          } catch (err) {
            throw new TubError(`cannot read ${file}: ${(err as Error).message}`)
          }
          return withDb((db) => {
            io.out(`added schema ${new SchemaRegistry(db).add(id, definition).id}`)
            return 0
          })
        }
        if (sub === "show" && rest.length === 1) {
          return withDb((db) => {
            const schema = new SchemaRegistry(db).get(rest[0]!)
            if (!schema) throw new TubError(`unknown schema '${rest[0]}'`)
            io.out(JSON.stringify(schema.definition, null, 2))
            return 0
          })
        }
        return usageError()

      case "backup": {
        if (rest.length > 0) return usageError()
        const dest = sub ?? defaultBackupPath()
        if (existsSync(dest)) throw new TubError(`${dest} already exists`)
        return withDb((db) => {
          // VACUUM INTO writes a consistent snapshot, safe while the server runs.
          db.query("VACUUM INTO $dest").run({ dest })
          io.out(`backed up ${dbPath} to ${dest}`)
          return 0
        })
      }

      default:
        io.err(`tub: unknown command '${command}'`)
        return usageError()
    }
  } catch (err) {
    if (err instanceof TubError) {
      io.err(`tub: ${err.message}`)
      return 1
    }
    throw err
  }
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2))
  if (code !== 0) process.exit(code)
}
