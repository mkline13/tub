import { expect, test } from "bun:test"
import { openDb } from "../src/db"
import { buildServer } from "../src/server"

test("health endpoint responds", async () => {
  const res = await buildServer().inject({ method: "GET", url: "/health" })
  expect(res.statusCode).toBe(200)
  expect(res.json<{ ok: boolean }>()).toEqual({ ok: true })
})

test("sqlite opens", () => {
  expect(openDb().query("select 1 as n").get()).toEqual({ n: 1 })
})
