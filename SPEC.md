# Tub

Typed, Local-First, Scoped Data Synchronization

## 1. Goal

Tub is a small, self-hosted synchronization server for structured application data.

Tub has three primary properties:

1. Typed — synchronized data conforms to explicit schemas.
2. Local-first — applications use a local RxDB database as their primary data store; synchronization happens in the background.
3. Scoped — access to data is controlled by explicit scopes.

Tub is not an application database, query service, or UI.

## 2. Architecture

```
             ┌──────────────────────────┐
             │           Tub            │
             │                          │
             │ SQLite                   │
             │ Documents                │
             │ Schemas                  │
             │ Change history           │
             │ Credentials              │
             │ Scope authorization      │
             └────────────┬─────────────┘
                          │
                   RxDB replication
                          │
             ┌────────────┴─────────────┐
             │                          │
        Application A             Application B
             │                          │
            RxDB                       RxDB
             │                          │
       local database            local database
```

Tub implements the RxDB replication protocol.

RxDB owns the local database experience. Tub provides authenticated, durable synchronization.

## 3. Typed Data

All synchronized data is structured JSON conforming to an explicit schema.

A document contains:

```ts
type Document = {
  id: string
  type: string
  schema: string
  data: unknown
  _deleted: boolean
  updatedAt: number
}
```

Schemas are identified by stable IDs and stored by Tub.

Tub validates incoming documents against their declared schema before accepting them.

Clients use corresponding RxDB schemas for local validation.

### Type invariant

No document enters trusted Tub storage without passing runtime validation against its declared schema.

The schema format should preferably be JSON Schema or another standard serializable format.

## 4. Local-First

The local RxDB database is the application's primary data store.

Normal application operation must not require network connectivity.

```
application
    ↓
local RxDB
    ↓
immediate local state
    ↓
background replication
    ↓
Tub
```

Reads are local.

Writes are local.

The network is used for synchronization, not ordinary application operation.

When offline:

* reads continue to work;
* writes continue to work;
* pending changes remain in the local database;
* synchronization resumes when connectivity returns.

Tub must not require clients to synchronously query the server for normal application operation.

## 5. Scopes

A scope is Tub's fundamental authorization boundary.

For the MVP:

```
RxDB collection ↔ Tub scope
```

For example:

```
RxDB collection: tasks
Tub scope:       tasks
```

The collection-to-scope mapping is a synchronization convention, not an authorization mechanism.

Tub must never authorize access merely because a client supplies a collection or scope name.

Every synchronized document belongs to exactly one scope.

A credential is explicitly granted access to one or more scopes.

```ts
type Credential = {
  id: string
  name: string
  scopes: string[]
  secretHash: string
  createdAt: number
  lastUsedAt?: number
  revokedAt?: number
}
```

Tub derives authorization from the authenticated credential.

### Scope invariants

A client may only synchronize scopes explicitly granted to its credential.

A client may only pull documents belonging to scopes it is authorized to access.

A client may only push changes to scopes it is authorized to access.

A client cannot grant itself access to another scope by modifying a request, document, or collection name.

Authorization must fail closed.

## 6. RxDB Replication

Tub implements the RxDB replication protocol rather than inventing a separate synchronization protocol.

### Pull

The client provides a checkpoint and requests a batch of changes.

Tub:

1. authenticates the credential;
2. determines its authorized scopes;
3. verifies that the requested collection/scope is authorized;
4. returns only documents belonging to that scope;
5. returns an appropriate checkpoint.

Conceptually:

```
pull(collection, checkpoint)
    ↓
authenticate
    ↓
map collection → scope
    ↓
authorize scope
    ↓
return only authorized documents
```

A client must never be able to use the pull API to enumerate or retrieve documents belonging to unauthorized scopes.

### Push

The client sends document changes containing the state it believes currently exists and the new state it wants to write.

Tub:

1. authenticates the credential;
2. determines the document's scope from the authenticated request/context;
3. verifies authorization for that scope;
4. validates the document;
5. checks the client's assumed server state;
6. writes the change if the state is current;
7. otherwise reports a conflict.

Tub must reject writes to unauthorized scopes.

A client-supplied collection or scope name must never override the server's authorization decision.

### Live changes

Tub may provide a live change stream using SSE, WebSockets, or another suitable mechanism.

The stream is only a notification mechanism; authorization still applies to every synchronized scope.

A simpler initial implementation may notify clients that synchronization is needed and allow normal checkpoint-based pulling to retrieve the changes.

## 7. Conflict Handling

Tub does not implement CRDT merging.

Writes use optimistic concurrency.

Conceptually:

```
client assumes: version A
Tub contains:   version B

        ↓

      conflict
```

Tub returns the current state rather than silently overwriting it.

RxDB handles the resulting conflict according to the collection's configured conflict policy.

This keeps merge semantics out of Tub.

## 8. Deletion

Deletion is represented as a synchronized tombstone rather than immediately removing the document.

```
{
  ...document,
  _deleted: true
}
```

Tombstones must remain available for replication long enough to prevent offline clients from resurrecting deleted documents.

## 9. Server Storage

Tub uses SQLite for the initial server implementation.

It stores at least:

```
scopes
credentials
schemas
documents
change history
```

Document changes and their synchronization metadata must be committed atomically.

Tub does not expose arbitrary SQL or application-level queries.

## 10. Authentication

Clients authenticate using individually revocable credentials.

Credentials are bearer secrets and are stored server-side only as cryptographic hashes.

Credentials represent individual applications or devices.

Example:

```
credential: laptop
    scopes:
      - personal
      - projects

credential: phone
    scopes:
      - personal
```

Revoking a credential immediately removes its ability to synchronize any associated scope.

The architecture should permit future finer-grained capabilities such as:

```
scope + read
scope + write
```

but the MVP only implements scope-level authorization.

## 11. Administration

Tub administration is local/terminal-based rather than through a web UI.

Example:

```
tub init

tub scopes list
tub scopes create personal

tub credentials create laptop
tub credentials revoke laptop

tub schemas list

tub backup
```

No administrative web application is required.

## 12. Security Invariants

These are core correctness requirements:

1. Authentication is required for synchronization.
2. Authorization is derived from the authenticated credential, never from client-supplied identity fields.
3. Every document belongs to exactly one scope.
4. A credential may access only explicitly granted scopes.
5. Pull operations return only documents from authorized scopes.
6. Push operations are accepted only for authorized scopes.
7. A client cannot obtain another scope's data by manipulating collection, scope, document, or request parameters.
8. Missing or invalid authorization fails closed.
9. Incoming documents are runtime-validated before trusted persistence.
10. Document writes use optimistic concurrency checks.
11. Credential secrets are never stored in plaintext.
12. TLS is required for remote connections.

## 13. Non-Goals

The MVP does not provide:

* server-side application queries;
* server-side full-text search;
* CRDTs;
* automatic server-side conflict merging;
* collaboration features;
* user accounts;
* OAuth/social login;
* web administration;
* application-specific APIs;
* application-specific business logic;
* cloud hosting;
* UI components.

## 14. Core Design Principle

Tub is:

A small, authenticated, typed, scoped persistence and synchronization layer for local RxDB databases.

RxDB owns:

```
local storage
queries
indexes
reactive queries
local projections
conflict policy
```

Tub owns:

```
authentication
authorization
scopes
schemas
durability
synchronization
```

The system should remain small enough that one developer can understand its complete data, synchronization, and security model.
