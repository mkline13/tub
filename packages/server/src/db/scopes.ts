import type { Database } from "bun:sqlite"
import { SCOPE_NAME_PATTERN } from "@mkline13/tub-shared"
import { TubError } from "./errors"

export type Scope = { name: string; createdAt: number }

export function createScope(db: Database, name: string): Scope {
  if (!SCOPE_NAME_PATTERN.test(name)) {
    throw new TubError(`invalid scope name '${name}': must match ${SCOPE_NAME_PATTERN}`)
  }
  if (scopeExists(db, name)) throw new TubError(`scope '${name}' already exists`)
  const createdAt = Date.now()
  db.query("INSERT INTO scopes (name, created_at) VALUES ($name, $createdAt)").run({ name, createdAt })
  return { name, createdAt }
}

export function listScopes(db: Database): Scope[] {
  return db
    .query("SELECT name, created_at AS createdAt FROM scopes ORDER BY name")
    .all() as Scope[]
}

export function scopeExists(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM scopes WHERE name = $name").get({ name }) !== null
}
