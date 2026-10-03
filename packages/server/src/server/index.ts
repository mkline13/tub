import Fastify from "fastify"

export function buildServer() {
  const app = Fastify()
  app.get("/health", async () => ({ ok: true }))
  return app
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8787)
  await buildServer().listen({ port, host: "127.0.0.1" })
}
