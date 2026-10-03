# Tub

Typed, local-first, scoped data synchronization for RxDB.

Tub is a small, self-hosted server that stores application documents in SQLite and syncs them with local RxDB databases using the RxDB replication protocol. Applications read and write their local RxDB database; Tub runs in the background as the authenticated, durable sync target.

- **Typed:** every document declares a schema (JSON Schema), and Tub validates it before storing it.
- **Local-first:** reads and writes are local, so apps keep working offline and sync when connectivity returns.
- **Scoped:** each credential is granted specific scopes (one RxDB collection maps to one scope), and Tub only syncs those.

Tub is not an application database, query service, or UI.

**Status:** MVP implemented: sync server, `tub` admin CLI and RxDB client helper, covered by unit and end-to-end tests.

## Documents

- [SPEC.md](./SPEC.md) is the MVP specification and stays as written.
- This README describes the project and the decisions made along the way, and is updated as work progresses.

## Decisions

These were settled before implementation started.

| Area | Choice |
| --- | --- |
| Runtime and package manager | [Bun](https://bun.sh) (`bun install`) with TypeScript |
| HTTP server | Fastify |
| Database | SQLite through Bun's built-in `bun:sqlite` |
| Schema validation | Ajv with JSON Schema |
| Tests | `bun test` |
| Repository | Private GitHub repo, MIT license |
| Layout | Bun workspace monorepo with `shared`, `server` and `client` packages |
| Client distribution | `@mkline13/tub-client`, published to GitHub Packages |

**Why a monorepo.** The spec's hardest guarantees, scope isolation and conflict handling, are only really proven by end-to-end tests with a real RxDB client talking to the server, which is simplest when both live in one repo. The document, credential and checkpoint types also live in one shared package, so the server and client cannot drift apart.

**Why the client stays thin.** Tub's contract is the RxDB replication protocol, so an app does not strictly need a Tub-specific client. `@mkline13/tub-client` only wires RxDB's replication up to a Tub server (URL and bearer credential). It must never grow into a second protocol.

**Why GitHub Packages.** The client is meant to be installed into future applications built on Tub. Because the repository is private, it is published to GitHub Packages with restricted access rather than to the public npm registry.

## Implementation decisions

These were made while implementing the MVP, where SPEC.md leaves a choice open.

- **Checkpoints are a server sequence number.** Every accepted write appends a row to the change history, and its autoincrement `seq` is the pull checkpoint (`{ seq }`). `updatedAt` is written by clients and is never used for ordering, so clock skew between devices cannot make a client miss changes.
- **Conflicts are detected by exact equality.** A push row is written only if its `assumedMasterState` equals the stored document (key order ignored), or if the document does not exist yet. Otherwise the stored document is returned as a conflict and nothing is overwritten. RxDB's conflict handler decides what happens next.
- **A push batch is validated as a whole.** If any row is malformed, names an unknown schema, or fails its schema, the whole request is rejected with `400` and nothing is written. Valid rows in a batch with conflicts are still written, in one transaction together with their change-history rows.
- **The URL names the scope; the credential decides.** Replication routes are `/replication/<scope>/...`. The scope must be one of the credential's grants or the request gets `403` (unknown and ungranted scopes look the same). The scope is never read from the document, and the same document id in two scopes is two separate documents.
- **Live changes are notifications only.** `GET /replication/<scope>/pull/stream` is server-sent events that only say `RESYNC`; documents always come through the normal authorized pull. The stream re-checks the credential on every event and heartbeat, so revoking a credential closes it.
- **Schemas are immutable.** A schema ID always means the same JSON Schema. A new version gets a new ID (`task.v2`). Tombstones are validated like any other document.
- **Tombstones are kept forever** in the MVP, which is the simplest way to guarantee offline clients cannot resurrect deleted documents.
- **Secrets are 256-bit random tokens** (`tub_...`) stored as SHA-256 hashes. A slow password hash is unnecessary for random tokens, and a deterministic hash allows an indexed lookup.
- **TLS is enforced at startup.** `tub serve` refuses to bind a non-loopback address without `--tls-cert` and `--tls-key`. Plain HTTP on `127.0.0.1` is allowed for local use or behind a TLS-terminating reverse proxy on the same host. The client likewise refuses `http://` URLs except for localhost.
- **`@mkline13/tub-shared` is published too**, alongside the client, because the client depends on its types.

## Layout

```
packages/
  shared/   @mkline13/tub-shared   Types used by server and client (Document, Credential, Checkpoint)
  server/   @mkline13/tub-server   Fastify sync server and the `tub` admin CLI
            src/server             HTTP routes
            src/cli                `tub` CLI (init, scopes, credentials, schemas, backup)
            src/db                 SQLite access
  client/   @mkline13/tub-client   Thin RxDB replication helper, installable into other apps
            examples/              Example apps
```

Administration happens through the `tub` CLI on the server machine. There is no web admin UI.

## Running a server

```
tub init                                          # creates ./tub.db (or --db / $TUB_DB)
tub scopes create tasks
tub schemas add task.v1 task.schema.json          # a JSON Schema for the document's `data`
tub credentials create laptop --scope tasks       # prints the secret once
tub serve                                         # http://127.0.0.1:8787
tub serve --host 0.0.0.0 --tls-cert cert.pem --tls-key key.pem
```

Other commands: `tub scopes list`, `tub credentials list`, `tub credentials revoke <name>`, `tub schemas list`, `tub schemas show <id>`, and `tub backup [path]`, which writes a consistent copy of the database even while the server is running. After restoring a backup, clients should start replication from scratch, because their checkpoints may point past the restored change history.

Replication API, all requiring `Authorization: Bearer <secret>`:

| Route | Purpose |
| --- | --- |
| `GET /replication/<scope>/pull?seq=<n>&limit=<n>` | Documents changed after checkpoint `seq` (limit 1 to 1000, default 100) |
| `POST /replication/<scope>/push` | RxDB push rows; returns the conflicting server documents |
| `GET /replication/<scope>/pull/stream` | Server-sent `RESYNC` notifications |
| `GET /health` | Liveness check, no auth |

## Development

Requires Bun.

```
bun install
bun test
bun run typecheck
bun run --cwd packages/server start   # run the server (reads TUB_DB, TUB_HOST, TUB_PORT, TUB_TLS_CERT, TUB_TLS_KEY)
bun run --cwd packages/server cli     # run the tub CLI
```

The client tests start a real Tub server and replicate real RxDB databases (in-memory storage) against it, covering live sync, offline writes, conflicts, scope isolation, validation errors and revocation.

CI (`.github/workflows/ci.yml`) runs install, typecheck and tests on every push to `main` and on every pull request.

## Using the client in another app

Once `@mkline13/tub-client` is published, an app installs it from GitHub Packages. Reading a private package needs a GitHub token with the `read:packages` scope. Add an `.npmrc` to the app (Bun and npm both read it):

```
@mkline13:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Then install the client alongside RxDB and RxJS, which are peer dependencies:

```
bun add @mkline13/tub-client rxdb rxjs
```

Each collection stores Tub documents (`id`, `type`, `schema`, `data`, `updatedAt`) and replicates with the scope of the same name:

```ts
import { createRxDatabase } from "rxdb"
import { getRxStorageDexie } from "rxdb/plugins/storage-dexie"
import { replicateTub, tubSchema } from "@mkline13/tub-client"

const db = await createRxDatabase({ name: "myapp", storage: getRxStorageDexie() })
await db.addCollections({ tasks: { schema: tubSchema({ data: taskJsonSchema }) } })

const replication = replicateTub({ collection: db.tasks, url: "https://tub.example.com", secret })
replication.error$.subscribe((err) => console.error(err))

// Reads and writes stay local; replication runs in the background.
await db.tasks.upsert({ id: crypto.randomUUID(), type: "task", schema: "task.v1", data: { title: "Buy milk" }, _deleted: false, updatedAt: Date.now() })
```

Set `updatedAt` on every write; RxDB conflict handlers can use it, but Tub does not.

## License

MIT
