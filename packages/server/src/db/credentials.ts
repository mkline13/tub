import type { Database } from "bun:sqlite"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import type { Credential } from "@mkline13/tub-shared"
import { TubError } from "./errors"
import { scopeExists } from "./scopes"

const SECRET_PREFIX = "tub_"
/** lastUsedAt is refreshed at most this often, to avoid a write on every request. */
const LAST_USED_RESOLUTION_MS = 60_000

/**
 * Secrets are 256 random bits, so a single fast hash is enough: there is
 * nothing to brute-force, and a deterministic hash allows an indexed lookup.
 */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex")
}

type CredentialRow = {
  id: string
  name: string
  secretHash: string
  createdAt: number
  lastUsedAt: number | null
  revokedAt: number | null
  scopes: string | null
}

const SELECT_CREDENTIAL = `
  SELECT c.id, c.name, c.secret_hash AS secretHash, c.created_at AS createdAt,
         c.last_used_at AS lastUsedAt, c.revoked_at AS revokedAt,
         (SELECT group_concat(scope, char(10)) FROM
            (SELECT scope FROM credential_scopes WHERE credential_id = c.id ORDER BY scope)) AS scopes
  FROM credentials c`

function toCredential(row: CredentialRow): Credential {
  const cred: Credential = {
    id: row.id,
    name: row.name,
    scopes: row.scopes ? row.scopes.split("\n") : [],
    secretHash: row.secretHash,
    createdAt: row.createdAt,
  }
  if (row.lastUsedAt !== null) cred.lastUsedAt = row.lastUsedAt
  if (row.revokedAt !== null) cred.revokedAt = row.revokedAt
  return cred
}

/** Creates a credential. The plaintext secret is returned once and never stored. */
export function createCredential(
  db: Database,
  name: string,
  scopes: string[],
): { credential: Credential; secret: string } {
  if (!name.trim()) throw new TubError("credential name must not be empty")
  const unique = [...new Set(scopes)].sort()
  if (unique.length === 0) throw new TubError("a credential needs at least one scope")
  for (const scope of unique) {
    if (!scopeExists(db, scope)) throw new TubError(`scope '${scope}' does not exist`)
  }
  if (db.query("SELECT 1 FROM credentials WHERE name = $name AND revoked_at IS NULL").get({ name })) {
    throw new TubError(`an active credential named '${name}' already exists`)
  }

  const secret = SECRET_PREFIX + randomBytes(32).toString("base64url")
  const credential: Credential = {
    id: randomUUID(),
    name,
    scopes: unique,
    secretHash: hashSecret(secret),
    createdAt: Date.now(),
  }
  db.transaction(() => {
    db.query(
      "INSERT INTO credentials (id, name, secret_hash, created_at) VALUES ($id, $name, $secretHash, $createdAt)",
    ).run({ id: credential.id, name, secretHash: credential.secretHash, createdAt: credential.createdAt })
    const grant = db.query("INSERT INTO credential_scopes (credential_id, scope) VALUES ($id, $scope)")
    for (const scope of unique) grant.run({ id: credential.id, scope })
  })()
  return { credential, secret }
}

export function listCredentials(db: Database): Credential[] {
  const rows = db.query(`${SELECT_CREDENTIAL} ORDER BY c.name, c.created_at`).all() as CredentialRow[]
  return rows.map(toCredential)
}

/** Revokes the active credential with this name. Takes effect on the next request. */
export function revokeCredential(db: Database, name: string): Credential {
  const row = db
    .query(`${SELECT_CREDENTIAL} WHERE c.name = $name AND c.revoked_at IS NULL`)
    .get({ name }) as CredentialRow | null
  if (!row) throw new TubError(`no active credential named '${name}'`)
  const revokedAt = Date.now()
  db.query("UPDATE credentials SET revoked_at = $revokedAt WHERE id = $id").run({ revokedAt, id: row.id })
  return { ...toCredential(row), revokedAt }
}

/**
 * Resolves a bearer secret to its active credential, or null. Revoked and
 * unknown secrets are indistinguishable to the caller.
 */
export function authenticateSecret(db: Database, secret: string): Credential | null {
  if (!secret.startsWith(SECRET_PREFIX)) return null
  const row = db
    .query(`${SELECT_CREDENTIAL} WHERE c.secret_hash = $hash AND c.revoked_at IS NULL`)
    .get({ hash: hashSecret(secret) }) as CredentialRow | null
  if (!row) return null
  const now = Date.now()
  if (row.lastUsedAt === null || now - row.lastUsedAt >= LAST_USED_RESOLUTION_MS) {
    db.query("UPDATE credentials SET last_used_at = $now WHERE id = $id").run({ now, id: row.id })
    row.lastUsedAt = now
  }
  return toCredential(row)
}

/** True if the credential is still active and still granted this scope. */
export function credentialHasScope(db: Database, credentialId: string, scope: string): boolean {
  return (
    db
      .query(
        `SELECT 1 FROM credentials c JOIN credential_scopes s ON s.credential_id = c.id
         WHERE c.id = $credentialId AND c.revoked_at IS NULL AND s.scope = $scope`,
      )
      .get({ credentialId, scope }) !== null
  )
}
