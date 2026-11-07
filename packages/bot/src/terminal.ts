import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

type Connection = { revision: string; updatedAt: number; permission: "read-only" | "read-write";
  credentials: { apiKey: string; secret: string; passphrase: string } | null };
const credentialsPath = () => process.env.TERMINAL_CREDENTIALS_PATH ?? "/app/data/terminal/bitget.json";
const controlPath = () => process.env.TERMINAL_CONTROL_PATH ?? "/credentials/control.json";
async function readControl() {
  try { const control = JSON.parse(await readFile(controlPath(), "utf8")); return { paused: control.paused !== false }; }
  catch (error) { return { paused: (error as NodeJS.ErrnoException).code !== "ENOENT" }; }
}
async function readConnection(): Promise<Connection | null> {
  try { return JSON.parse(await readFile(credentialsPath(), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function publicConnection(config: Connection | null) {
  return { configured: !!config?.credentials, permission: config?.permission ?? "read-only",
    revision: config?.revision ?? null, updatedAt: config?.updatedAt ?? null, capability: "monitoring-only" };
}

export function registerTerminal(app: FastifyInstance) {
  async function authorize(request: FastifyRequest, reply: FastifyReply) {
    reply.header("Cache-Control", "no-store");
    const secret = Buffer.from(process.env.ADMIN_PASSWORD ?? "");
    const provided = Buffer.from(request.headers.authorization ?? "");
    if (!secret.length || secret.length !== provided.length || !timingSafeEqual(secret, provided)) {
      return reply.code(401).send({ message: "Sign in to view the terminal" });
    }
    if (request.method !== "GET" && request.headers.origin &&
        request.headers.origin !== (process.env.TERMINAL_ORIGIN ?? "https://trade.amsstay.com")) {
      return reply.code(403).send({ message: "Use the dashboard to update settings" });
    }
  }
  app.get("/api/terminal/connection", { preHandler: authorize }, async (_request, reply) => {
    try { return publicConnection(await readConnection()); }
    catch { return reply.code(503).send({ message: "Connection settings are unavailable" }); }
  });
  app.put("/api/terminal/control", { preHandler: authorize, bodyLimit: 512 }, async (request, reply) => {
    const body = request.body as { paused?: unknown } | undefined;
    if (typeof body?.paused !== "boolean") return reply.code(400).send({ message: "Choose pause or resume" });
    try {
      const filename = controlPath();
      await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
      const temporary = filename + "." + randomUUID() + ".tmp";
      await writeFile(temporary, JSON.stringify({ paused: body.paused }), { mode: 0o600, flag: "wx" });
      await rename(temporary, filename);
      return { paused: body.paused };
    } catch { return reply.code(503).send({ message: "Agent control could not be saved" }); }
  });
  app.route({ method: ["PUT", "DELETE"], url: "/api/terminal/connection", bodyLimit: 4096,
    preHandler: authorize, handler: async (request, reply) => {
      try {
        const body = request.body as Record<string, unknown> | undefined;
        let credentials: Connection["credentials"] = null;
        let permission: Connection["permission"] = "read-only";
        if (request.method === "PUT") {
          if (!body || !["read-only", "read-write"].includes(String(body.permission))) {
            return reply.code(400).send({ message: "Choose the API key permission" });
          }
          permission = body.permission as Connection["permission"];
          const values = [body.apiKey, body.secret, body.passphrase];
          if (values.every((value) => value === undefined || value === "")) {
            credentials = (await readConnection())?.credentials ?? null;
            if (!credentials) return reply.code(400).send({ message: "Enter all three Bitget credentials" });
          } else {
            if (!values.every((value) => typeof value === "string" && value.trim().length > 0 &&
                value.length <= 512 && !/[\r\n\x00]/.test(value))) {
              return reply.code(400).send({ message: "Enter a valid API key, secret and passphrase together" });
            }
            credentials = { apiKey: String(body.apiKey).trim(), secret: String(body.secret).trim(),
              passphrase: String(body.passphrase) };
          }
        }
        const config: Connection = { credentials, permission, revision: randomUUID(), updatedAt: Date.now() };
        const filename = credentialsPath();
        await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
        const temporary = filename + "." + config.revision + ".tmp";
        await writeFile(temporary, JSON.stringify(config), { mode: 0o600, flag: "wx" });
        await rename(temporary, filename);
        return publicConnection(config);
      } catch { return reply.code(503).send({ message: "Settings could not be saved. Please try again." }); }
    } });
  app.get("/api/terminal/state", { preHandler: authorize }, async (_request, reply) => {
    try {
      const state = JSON.parse(await readFile(process.env.TERMINAL_STATE_PATH ?? "/app/data/terminal/state.json", "utf8"));
      const config = await readConnection();
      if (config && config.revision !== state.connectionRevision) {
        state.account = null;
        state.equityHistory = [];
        state.accountStatus = config.credentials ? "validating" : "not-connected";
        state.agents = null;
      }
      const control = await readControl();
      if (control.paused !== state.agents?.paused) state.agents = null;
      return { ...state, control, connection: publicConnection(config) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { updatedAt: null, markets: [], account: null, accountStatus: "not-connected", logs: [] };
      }
      return reply.code(503).send({ message: "Market monitor is temporarily unavailable" });
    }
  });
}
