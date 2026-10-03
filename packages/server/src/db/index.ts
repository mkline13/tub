import { Database } from "bun:sqlite"

/** Opens (and will eventually migrate) the Tub SQLite database. */
export function openDb(path = ":memory:"): Database {
  const db = new Database(path)
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
  return db
}
