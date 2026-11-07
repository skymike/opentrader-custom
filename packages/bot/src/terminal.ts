import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { presentCommentary } from "../../exchanges/terminal-assistant.mjs";
import { registerTrading } from "../../exchanges/terminal-trading-api.mjs";
import { registerOriginalApi } from "../../exchanges/terminal-original-api.mjs";
import { readConnection, publicConnection, registerConnections } from "../../exchanges/terminal-connections.mjs";

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
  registerConnections(app, authorize);
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
