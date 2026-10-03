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

/** RxDB replication checkpoint: the last document seen, ordered by (updatedAt, id). */
export type Checkpoint = {
  id: string
  updatedAt: number
}
