import { expect, test } from "bun:test"
import { authHeaders } from "../src"

test("authHeaders builds a bearer header", () => {
  expect(authHeaders({ url: "http://x", secret: "s" })).toEqual({ authorization: "Bearer s" })
})
