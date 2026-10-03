import type { Database } from "bun:sqlite"
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv"
import { MAX_ID_LENGTH } from "@mkline13/tub-shared"
import { TubError } from "./errors"

export const SCHEMA_ID_PATTERN = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,${MAX_ID_LENGTH - 1}}$`)

export type StoredSchema = { id: string; definition: object; createdAt: number }

/** Each schema compiles in its own Ajv instance so `$id`s in different schemas cannot collide. */
function compile(definition: unknown): ValidateFunction {
  if (typeof definition !== "object" || definition === null || Array.isArray(definition)) {
    throw new TubError("a schema must be a JSON object")
  }
  try {
    return new Ajv({ allErrors: true, strict: true }).compile(definition)
  } catch (err) {
    throw new TubError(`invalid JSON Schema: ${(err as Error).message}`)
  }
}

/**
 * Schemas are immutable once added: a schema ID always means the same
 * definition, so a new version gets a new ID (e.g. `task.v2`). That also
 * makes the compiled-validator cache safe to keep for the process lifetime.
 */
export class SchemaRegistry {
  private validators = new Map<string, ValidateFunction>()

  constructor(private db: Database) {}

  add(id: string, definition: unknown): StoredSchema {
    if (!SCHEMA_ID_PATTERN.test(id)) throw new TubError(`invalid schema id '${id}': must match ${SCHEMA_ID_PATTERN}`)
    if (this.get(id)) throw new TubError(`schema '${id}' already exists; schemas are immutable, add a new id instead`)
    compile(definition)
    const createdAt = Date.now()
    this.db
      .query("INSERT INTO schemas (id, definition, created_at) VALUES ($id, $definition, $createdAt)")
      .run({ id, definition: JSON.stringify(definition), createdAt })
    return { id, definition: definition as object, createdAt }
  }

  get(id: string): StoredSchema | null {
    const row = this.db
      .query("SELECT id, definition, created_at AS createdAt FROM schemas WHERE id = $id")
      .get({ id }) as { id: string; definition: string; createdAt: number } | null
    return row && { ...row, definition: JSON.parse(row.definition) }
  }

  list(): StoredSchema[] {
    const rows = this.db
      .query("SELECT id, definition, created_at AS createdAt FROM schemas ORDER BY id")
      .all() as { id: string; definition: string; createdAt: number }[]
    return rows.map((row) => ({ ...row, definition: JSON.parse(row.definition) }))
  }

  /** Returns validation errors for `data`, or null if valid. Throws if the schema is unknown. */
  validate(id: string, data: unknown): ErrorObject[] | null {
    let validator = this.validators.get(id)
    if (!validator) {
      const schema = this.get(id)
      if (!schema) throw new TubError(`unknown schema '${id}'`)
      validator = compile(schema.definition)
      this.validators.set(id, validator)
    }
    return validator(data) ? null : (validator.errors ?? [])
  }
}
