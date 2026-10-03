// Thin helper around RxDB's replication plugin. Tub speaks the RxDB replication
// protocol; this package only wires up URL + bearer credential. Keep it small.
export type { Checkpoint, Document } from "@mkline13/tub-shared"

export type TubClientOptions = {
  /** Base URL of the Tub server, e.g. https://tub.example.com */
  url: string
  /** Bearer credential secret issued by `tub credentials create`. */
  secret: string
}

export function authHeaders(opts: TubClientOptions): Record<string, string> {
  return { authorization: `Bearer ${opts.secret}` }
}
