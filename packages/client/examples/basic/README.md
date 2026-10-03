# Example app

A minimal app that keeps a local RxDB collection of tasks in sync with Tub. See the client section of the [root README](../../../../README.md#using-the-client-in-another-app) for installation.

Server setup:

```
tub init
tub scopes create tasks
tub schemas add task.v1 task.schema.json
tub credentials create example --scope tasks
tub serve
```

`task.schema.json`:

```json
{
  "type": "object",
  "properties": { "title": { "type": "string" }, "done": { "type": "boolean" } },
  "required": ["title"],
  "additionalProperties": false
}
```

App code:

```ts
import { createRxDatabase } from "rxdb"
import { getRxStorageMemory } from "rxdb/plugins/storage-memory"
import { replicateTub, tubSchema } from "@mkline13/tub-client"
import taskSchema from "./task.schema.json"

const db = await createRxDatabase({ name: "example", storage: getRxStorageMemory() })
await db.addCollections({ tasks: { schema: tubSchema({ data: taskSchema }) } })

const replication = replicateTub({
  collection: db.tasks,
  url: "http://127.0.0.1:8787",
  secret: process.env.TUB_SECRET!,
})
replication.error$.subscribe((err) => console.error("sync error", err))

db.tasks.find().$.subscribe((docs) => console.log(docs.map((d) => d.data)))

await db.tasks.insert({
  id: crypto.randomUUID(),
  type: "task",
  schema: "task.v1",
  data: { title: "Try Tub", done: false },
  _deleted: false,
  updatedAt: Date.now(),
})
```

Run it twice with the same secret and the two processes see each other's tasks.
