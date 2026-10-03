import { expect, test } from "bun:test"
import type { Checkpoint, Document } from "../src"

test("shared types are usable", () => {
  const doc: Document = { id: "1", type: "task", schema: "task.v1", data: {}, _deleted: false, updatedAt: 0 }
  const cp: Checkpoint = { id: doc.id, updatedAt: doc.updatedAt }
  expect(cp.id).toBe("1")
})
