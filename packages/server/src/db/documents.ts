import type { Database } from "bun:sqlite"
import Ajv from "ajv"
import {
  MAX_ID_LENGTH,
  MAX_PUSH_BATCH,
  type Checkpoint,
  type Document,
  type PullResponse,
  type PushRow,
} from "@mkline13/tub-shared"
import { TubError } from "./errors"
import type { SchemaRegistry } from "./schemas"

const DOCUMENT_ENVELOPE = {
  type: "object",
  additionalProperties: false,
  required: ["id", "type", "schema", "data", "_deleted", "updatedAt"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: MAX_ID_LENGTH },
    type: { type: "string", minLength: 1, maxLength: MAX_ID_LENGTH },
    schema: { type: "string", minLength: 1, maxLength: MAX_ID_LENGTH },
    data: {},
    _deleted: { type: "boolean" },
    updatedAt: { type: "number" },
  },
} as const

const validateRows = new Ajv({ allErrors: true }).compile({
  type: "array",
  maxItems: MAX_PUSH_BATCH,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["newDocumentState"],
    properties: { assumedMasterState: DOCUMENT_ENVELOPE, newDocumentState: DOCUMENT_ENVELOPE },
  },
})

/** Fields RxDB keeps locally that are not part of a Tub document. */
const RXDB_LOCAL_FIELDS = ["_meta", "_rev", "_attachments"]

function stripLocalFields(doc: unknown): unknown {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return doc
  const copy: Record<string, unknown> = { ...doc }
  for (const field of RXDB_LOCAL_FIELDS) delete copy[field]
  return copy
}

type DocumentRow = {
  id: string
  type: string
  schema: string
  data: string
  deleted: number
  updatedAt: number
  seq: number
}

const SELECT_DOCUMENT = `SELECT id, type, schema, data, deleted, updated_at AS updatedAt, seq FROM documents`

function toDocument(row: DocumentRow): Document {
  return {
    id: row.id,
    type: row.type,
    schema: row.schema,
    data: JSON.parse(row.data),
    _deleted: row.deleted === 1,
    updatedAt: row.updatedAt,
  }
}

/**
 * Returns up to `limit` documents in `scope` changed after `checkpoint`, in
 * change order. Callers must have authorized `scope`; this function never
 * reads outside it.
 */
export function pullDocuments(
  db: Database,
  scope: string,
  checkpoint: Checkpoint | undefined,
  limit: number,
): PullResponse {
  const after = checkpoint?.seq ?? 0
  const rows = db
    .query(`${SELECT_DOCUMENT} WHERE scope = $scope AND seq > $after ORDER BY seq LIMIT $limit`)
    .all({ scope, after, limit }) as DocumentRow[]
  const last = rows.at(-1)
  return { documents: rows.map(toDocument), checkpoint: { seq: last ? last.seq : after } }
}

export function getDocument(db: Database, scope: string, id: string): Document | null {
  const row = db.query(`${SELECT_DOCUMENT} WHERE scope = $scope AND id = $id`).get({ scope, id }) as DocumentRow | null
  return row && toDocument(row)
}

/** Structural equality for JSON values; object key order does not matter. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const other = b as unknown[]
    return a.length === other.length && a.every((v, i) => jsonEqual(v, other[i]))
  }
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  return ak.every(
    (k) => Object.hasOwn(b, k) && jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  )
}

/** Validates a push body without touching storage. Throws a TubError listing every problem. */
export function parsePushRows(schemas: SchemaRegistry, body: unknown): PushRow[] {
  const candidate = Array.isArray(body) ? body.map(normalizeRow) : body
  if (!validateRows(candidate)) {
    throw new TubError("malformed push request", validateRows.errors)
  }
  const rows = candidate as PushRow[]
  const problems: { index: number; id: string; error: string; details?: unknown }[] = []
  rows.forEach((row, index) => {
    const doc = row.newDocumentState
    try {
      const errors = schemas.validate(doc.schema, doc.data)
      if (errors) problems.push({ index, id: doc.id, error: `data does not match schema '${doc.schema}'`, details: errors })
    } catch (err) {
      if (!(err instanceof TubError)) throw err
      problems.push({ index, id: doc.id, error: err.message })
    }
  })
  if (problems.length > 0) throw new TubError("document validation failed", problems)
  return rows
}

function normalizeRow(row: unknown): unknown {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return row
  const copy: Record<string, unknown> = { ...row }
  if ("newDocumentState" in copy) copy.newDocumentState = stripLocalFields(copy.newDocumentState)
  if ("assumedMasterState" in copy) copy.assumedMasterState = stripLocalFields(copy.assumedMasterState)
  return copy
}

/**
 * Applies a push batch to `scope` with optimistic concurrency, atomically.
 * A row is written only if the client's assumed state equals the current
 * server state (or the document does not exist yet); otherwise the current
 * server state is returned as a conflict and the row is not written.
 * Callers must have authorized `scope` and validated rows with parsePushRows.
 */
export function pushDocuments(
  db: Database,
  scope: string,
  credentialId: string,
  rows: PushRow[],
): { conflicts: Document[]; written: number } {
  const conflicts: Document[] = []
  let written = 0
  const insertChange = db.query(
    `INSERT INTO changes (scope, doc_id, document, credential_id, created_at)
     VALUES ($scope, $docId, $document, $credentialId, $createdAt) RETURNING seq`,
  )
  const upsert = db.query(
    `INSERT INTO documents (scope, id, type, schema, data, deleted, updated_at, seq)
     VALUES ($scope, $id, $type, $schema, $data, $deleted, $updatedAt, $seq)
     ON CONFLICT (scope, id) DO UPDATE SET type = excluded.type, schema = excluded.schema,
       data = excluded.data, deleted = excluded.deleted, updated_at = excluded.updated_at, seq = excluded.seq`,
  )

  db.transaction(() => {
    const now = Date.now()
    for (const { assumedMasterState, newDocumentState: doc } of rows) {
      const current = getDocument(db, scope, doc.id)
      if (current && (!assumedMasterState || !jsonEqual(assumedMasterState, current))) {
        conflicts.push(current)
        continue
      }
      const { seq } = insertChange.get({
        scope,
        docId: doc.id,
        document: JSON.stringify(doc),
        credentialId,
        createdAt: now,
      }) as { seq: number }
      upsert.run({
        scope,
        id: doc.id,
        type: doc.type,
        schema: doc.schema,
        data: JSON.stringify(doc.data),
        deleted: doc._deleted ? 1 : 0,
        updatedAt: doc.updatedAt,
        seq,
      })
      written++
    }
  }).immediate()

  return { conflicts, written }
}
