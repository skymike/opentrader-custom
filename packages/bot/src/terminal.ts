import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { presentCommentary } from "../../exchanges/terminal-assistant.mjs";
import { registerTrading } from "../../exchanges/terminal-trading-api.mjs";
import { registerOriginalApi } from "../../exchanges/terminal-original-api.mjs";

type Connection = { revision: string; updatedAt: number; permission: "read-only" | "read-write";
  apiVersion?: 'v2' | 'v3'; environment?: 'demo' | 'live';
  credentials: { apiKey: string; secret: string; passphrase: string } | null };
const credentialsPath = () => process.env.TERMINAL_CREDENTIALS_PATH ?? "/app/data/terminal/bitget.json";
const controlPath = () => process.env.TERMINAL_CONTROL_PATH ?? "/credentials/control.json";
const assistantPath = () => process.env.TERMINAL_ASSISTANT_PATH ?? "/assistant";
async function readAssistantSettings() {
  try { return JSON.parse(await readFile(assistantPath() + "/settings.json", "utf8")); }
  catch { return { enabled: false }; }
}
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
    apiVersion: config?.apiVersion ?? 'v2', environment: config?.environment ?? 'live',
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
  registerTrading(app, authorize);
  registerOriginalApi(app, authorize);
  app.get("/api/terminal/connection", { preHandler: authorize }, async (_request, reply) => {
    try { return publicConnection(await readConnection()); }
    catch { return reply.code(503).send({ message: "Connection settings are unavailable" }); }
  });
  app.put("/api/terminal/assistant", { preHandler: authorize, bodyLimit: 512 }, async (request, reply) => {
    const body = request.body as { enabled?: unknown } | undefined;
    if (typeof body?.enabled !== "boolean") return reply.code(400).send({ message: "Choose whether AI commentary is enabled" });
    try {
      const filename = assistantPath() + "/settings.json";
      await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
      const settings = { enabled: body.enabled, revision: randomUUID() };
      const temporary = filename + "." + settings.revision + ".tmp";
      await writeFile(temporary, JSON.stringify(settings), { mode: 0o600, flag: "wx" });
      await rename(temporary, filename);
      return { enabled: settings.enabled };
    } catch { return reply.code(503).send({ message: "AI setting could not be saved" }); }
  });
  app.get("/api/terminal/assistant", { preHandler: authorize }, async () => {
    const settings = await readAssistantSettings();
    let state: any = {};
    let saved;
    try {
      state = JSON.parse(await readFile(process.env.TERMINAL_STATE_PATH ?? "/app/data/terminal/state.json", "utf8"));
      const config = await readConnection();
      const control = await readControl();
      if ((config && config.revision !== state.connectionRevision) || control.paused !== state.agents?.paused) {
        state = {}; // Never explain a previous account or an outdated operator decision.
      }
      saved = JSON.parse(await readFile(assistantPath() + "/commentary.json", "utf8"));
    } catch { /* Cached commentary is optional; trading-state endpoints stay independent. */ }
    return presentCommentary(saved, state, settings);
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
        const apiVersion = body?.apiVersion ?? 'v2';
        const environment = body?.environment ?? 'live';
        if (!['v2', 'v3'].includes(String(apiVersion)) || !['demo', 'live'].includes(String(environment))) return reply.code(400).send({ message: 'Select API and environment' });
        const config: Connection = { credentials, permission, apiVersion: apiVersion as 'v2' | 'v3', environment: environment as 'demo' | 'live', revision: randomUUID(), updatedAt: Date.now() };
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
