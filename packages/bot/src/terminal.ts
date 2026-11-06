import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";

export function registerTerminal(app: FastifyInstance) {
  app.get("/api/terminal/state", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const secret = Buffer.from(process.env.ADMIN_PASSWORD ?? "");
    const provided = Buffer.from(request.headers.authorization ?? "");
    if (!secret.length || secret.length !== provided.length || !timingSafeEqual(secret, provided)) {
      return reply.code(401).send({ message: "Sign in to view the terminal" });
    }
    try {
      return JSON.parse(await readFile(process.env.TERMINAL_STATE_PATH ?? "/app/data/terminal/state.json", "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { updatedAt: null, markets: [], account: null, accountStatus: "not-connected", logs: [] };
      }
      return reply.code(503).send({ message: "Market monitor is temporarily unavailable" });
    }
  });
}
