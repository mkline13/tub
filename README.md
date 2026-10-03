# Tub

Typed, local-first, scoped data synchronization for RxDB. Tub is a small self-hosted server that stores documents in SQLite and implements the RxDB replication protocol with per-credential scope authorization. The full design is in [SPEC.md](./SPEC.md).

**Status:** project scaffold only; the MVP is not implemented yet.

## Layout

Bun workspace monorepo:

- `packages/shared`: types used by both sides (`Document`, `Credential`, `Checkpoint`).
- `packages/server`: Fastify server and the `tub` admin CLI, using `bun:sqlite` and Ajv. Source is split into `src/server`, `src/cli`, `src/db`.
- `packages/client`: `@mkline13/tub-client`, a thin RxDB replication helper meant to be installed into other apps (published to GitHub Packages), plus `examples/`.

## Development

```
bun install
bun test
bun run typecheck
bun run --cwd packages/server start   # run the server
bun run --cwd packages/server cli     # run the tub CLI
```

## License

MIT
