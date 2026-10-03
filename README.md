# Tub

Typed, local-first, scoped data synchronization for RxDB.

Tub is a small, self-hosted server that stores application documents in SQLite and syncs them with local RxDB databases using the RxDB replication protocol. Applications read and write their local RxDB database; Tub runs in the background as the authenticated, durable sync target.

- **Typed:** every document declares a schema (JSON Schema), and Tub validates it before storing it.
- **Local-first:** reads and writes are local, so apps keep working offline and sync when connectivity returns.
- **Scoped:** each credential is granted specific scopes (one RxDB collection maps to one scope), and Tub only syncs those.

Tub is not an application database, query service, or UI.

**Status:** project scaffold. The MVP is being implemented.

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

## Development

Requires Bun.

```
bun install
bun test
bun run typecheck
bun run --cwd packages/server start   # run the server (PORT, default 8787, on 127.0.0.1)
bun run --cwd packages/server cli     # run the tub CLI
```

CI (`.github/workflows/ci.yml`) runs install, typecheck and tests on every push to `main` and on every pull request.

## Using the client in another app

Once `@mkline13/tub-client` is published, an app installs it from GitHub Packages. Reading a private package needs a GitHub token with the `read:packages` scope. Add an `.npmrc` to the app (Bun and npm both read it):

```
@mkline13:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Then install the client alongside RxDB, which is a peer dependency:

```
bun add @mkline13/tub-client rxdb
```

## License

MIT
