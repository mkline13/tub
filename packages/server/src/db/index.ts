import { Database } from "bun:sqlite"

/**
 * Schema migrations, applied in order. `PRAGMA user_version` records how many
 * have run. Never edit a released migration; append a new one.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE scopes (
    name       TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE credentials (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    secret_hash  TEXT NOT NULL UNIQUE,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at   INTEGER
  ) STRICT;
  -- A name may be reused once the credential holding it is revoked.
  CREATE UNIQUE INDEX credentials_active_name ON credentials(name) WHERE revoked_at IS NULL;

  CREATE TABLE credential_scopes (
    credential_id TEXT NOT NULL REFERENCES credentials(id),
    scope         TEXT NOT NULL REFERENCES scopes(name),
    PRIMARY KEY (credential_id, scope)
  ) STRICT;

  CREATE TABLE schemas (
    id         TEXT PRIMARY KEY,
    definition TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;

  -- Latest state of every document, tombstones included. A document is
  -- identified by (scope, id): the same id in two scopes is two documents.
  CREATE TABLE documents (
    scope      TEXT NOT NULL REFERENCES scopes(name),
    id         TEXT NOT NULL,
    type       TEXT NOT NULL,
    schema     TEXT NOT NULL REFERENCES schemas(id),
    data       TEXT NOT NULL,
    deleted    INTEGER NOT NULL,
    updated_at REAL NOT NULL,
    seq        INTEGER NOT NULL,
    PRIMARY KEY (scope, id)
  ) STRICT;
  CREATE UNIQUE INDEX documents_scope_seq ON documents(scope, seq);

  -- Append-only change history. Its seq is the replication checkpoint.
  CREATE TABLE changes (
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    scope         TEXT NOT NULL REFERENCES scopes(name),
    doc_id        TEXT NOT NULL,
    document      TEXT NOT NULL,
    credential_id TEXT NOT NULL REFERENCES credentials(id),
    created_at    INTEGER NOT NULL
  ) STRICT;
  `,
]

/** Opens the Tub SQLite database and applies any pending migrations. */
export function openDb(path = ":memory:"): Database {
  const db = new Database(path, { strict: true })
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
  migrate(db)
  return db
}

export function migrate(db: Database): void {
  const { user_version: current } = db.query("PRAGMA user_version").get() as { user_version: number }
  if (current > MIGRATIONS.length) {
    throw new Error(`database schema version ${current} is newer than this tub (${MIGRATIONS.length})`)
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!)
      db.exec(`PRAGMA user_version = ${v + 1}`)
    })()
  }
}
