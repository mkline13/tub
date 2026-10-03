/** Types shared by the Tub server and client. Single source of truth. */

export type Document = {
  id: string
  type: string
  schema: string
  data: unknown
  _deleted: boolean
  updatedAt: number
}

export type Credential = {
  id: string
  name: string
  scopes: string[]
  secretHash: string
  createdAt: number
  lastUsedAt?: number
  revokedAt?: number
}

/**
 * RxDB replication checkpoint. `seq` is a server-assigned, strictly increasing
 * change sequence number, so ordering never depends on client clocks
 * (`updatedAt` is written by clients and is not trusted for ordering).
 */
export type Checkpoint = {
  seq: number
}

/** One row of a push request, as sent by RxDB's replication protocol. */
export type PushRow = {
  assumedMasterState?: Document
  newDocumentState: Document
}

/** Pull response body. `checkpoint` is the position to resume from. */
export type PullResponse = {
  documents: Document[]
  checkpoint: Checkpoint
}

/** Push response body: the current server state of every conflicting document. */
export type PushResponse = Document[]

/**
 * Valid scope names. Scopes map 1:1 to RxDB collection names, so this is a
 * subset of what RxDB accepts for collection names.
 */
export const SCOPE_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/

/** Limits shared by server and client. */
export const MAX_PULL_BATCH = 1000
export const MAX_PUSH_BATCH = 1000
export const MAX_ID_LENGTH = 128
