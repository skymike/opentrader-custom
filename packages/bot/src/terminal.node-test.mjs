import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { registerTerminal } from "./terminal.ts";
import { createAssistant } from "../../exchanges/terminal-assistant.mjs";

test("commentary is authenticated, cached and immediately hidden on pause or account changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "terminal-ai-"));
  const keys = ["ADMIN_PASSWORD", "TERMINAL_ASSISTANT_PATH", "TERMINAL_STATE_PATH", "TERMINAL_CREDENTIALS_PATH", "TERMINAL_CONTROL_PATH"];
  const previous = keys.map((key) => process.env[key]);
  process.env.ADMIN_PASSWORD = "test-password";
  process.env.TERMINAL_ASSISTANT_PATH = directory;
  process.env.TERMINAL_STATE_PATH = join(directory, "state.json");
  process.env.TERMINAL_CREDENTIALS_PATH = join(directory, "connection.json");
  process.env.TERMINAL_CONTROL_PATH = join(directory, "control.json");
  const app = Fastify(); registerTerminal(app);
  const headers = { authorization: "test-password" };
  const url = "/api/terminal/assistant";
  try {
    assert.equal((await app.inject(url)).statusCode, 401);
    assert.equal((await app.inject({ url, method: "PUT", payload: { enabled: true } })).statusCode, 401);
    assert.equal((await app.inject({ url, method: "PUT", headers: { ...headers, origin: "https://evil.example" }, payload: { enabled: true } })).statusCode, 403);
    assert.equal((await app.inject({ url, method: "PUT", headers, payload: { enabled: "yes" } })).statusCode, 400);
    assert.equal((await app.inject({ url, headers })).json().status, "disabled");
    const saved = await app.inject({ url, method: "PUT", headers, payload: { enabled: true } });
    assert.equal(saved.statusCode, 200);
    const settings = JSON.parse(await readFile(join(directory, "settings.json"), "utf8"));
    const state = { updatedAt: Date.now(), connectionRevision: "a", accountStatus: "connected", markets: [], logs: [],
      agents: { paused: false, decisions: [] } };
    await writeFile(process.env.TERMINAL_STATE_PATH, JSON.stringify(state));
    await createAssistant({ readSettings: async () => settings, readState: async () => state,
      generate: async () => "The terminal recorded no new activity.",
      write: async (result) => writeFile(join(directory, "commentary.json"), JSON.stringify(result)) }).tick();
    const result = await app.inject({ url, headers });
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(result.json().status, "ready");
    await writeFile(process.env.TERMINAL_CONTROL_PATH, JSON.stringify({ paused: true }));
    assert.equal((await app.inject({ url, headers })).json().summary, undefined);
    await writeFile(process.env.TERMINAL_CONTROL_PATH, JSON.stringify({ paused: false }));
    await writeFile(process.env.TERMINAL_CREDENTIALS_PATH, JSON.stringify({ revision: "b", credentials: null }));
    assert.equal((await app.inject({ url, headers })).json().summary, undefined);
    await app.inject({ url, method: "PUT", headers, payload: { enabled: false } });
    assert.equal((await app.inject({ url, headers })).json().status, "disabled");
    assert.equal((await app.inject({url,method:'PUT',headers,payload:{enabled:true,requestAnalysis:true}})).statusCode,200);
    assert.equal((await app.inject({url,method:'PUT',headers,payload:{enabled:true,requestAnalysis:true}})).statusCode,429);
    for (const symbol of ["SOL/USDT", "XRP/USDT"]) {
      const followed = await app.inject({ url, method: "PUT", headers, payload: { followSelection: true, symbol } });
      assert.equal(followed.statusCode, 200);
      assert.equal((await app.inject({ url, headers })).json().selectedSymbol, symbol);
    }
    await writeFile(join(directory, "settings.json"), "{malformed");
    assert.equal((await app.inject({ url, headers })).json().enabled, false);
  } finally {
    await app.close();
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
    await rm(directory, { recursive: true, force: true });
  }
});

test("terminal protects account data and securely manages connection settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "classic-terminal-"));
  const oldPassword = process.env.ADMIN_PASSWORD;
  const oldPath = process.env.TERMINAL_STATE_PATH;
  const oldCredentialsPath = process.env.TERMINAL_CREDENTIALS_PATH;
  const oldControlPath = process.env.TERMINAL_CONTROL_PATH;
  process.env.ADMIN_PASSWORD = "test-password";
  process.env.TERMINAL_STATE_PATH = join(directory, "state.json");
  process.env.TERMINAL_CREDENTIALS_PATH = join(directory, "credentials", "bitget.json");
  process.env.TERMINAL_CONTROL_PATH = join(directory, "credentials", "control.json");
  const app = Fastify();
  registerTerminal(app);
  try {
    assert.equal((await app.inject("/api/terminal/state")).statusCode, 401);
    assert.equal((await app.inject({ url: "/api/terminal/state", headers: { authorization: "incorrect" } })).statusCode, 401);
    const headers = { authorization: "test-password" };
    assert.equal((await app.inject({ url: "/api/terminal/state", method: "POST", headers })).statusCode, 404);
    assert.equal((await app.inject({ url: "/api/terminal/state", headers })).json().account, null);
    await writeFile(process.env.TERMINAL_STATE_PATH, JSON.stringify({ account: { equity: 10 } }));
    const response = await app.inject({ url: "/api/terminal/state", headers });
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.json().account.equity, 10);
    await writeFile(process.env.TERMINAL_STATE_PATH, "{bad");
    assert.equal((await app.inject({ url: "/api/terminal/state", headers })).statusCode, 503);
    const url = "/api/terminal/connection";
    const payload = { apiKey: "fixture-key", secret: "fixture-secret", passphrase: "fixture-passphrase", permission: "read-write" };
    for (const method of ["GET", "PUT", "DELETE"]) {
      assert.equal((await app.inject({ url, method, ...(method === "PUT" ? { payload } : {}) })).statusCode, 401);
    }
    assert.equal((await app.inject({ url, method: "PUT", headers: { ...headers, origin: "https://untrusted.example" }, payload })).statusCode, 403);
    assert.equal((await app.inject({ url, method: "PUT", headers, payload: { ...payload, secret: "" } })).statusCode, 400);
    const saved = await app.inject({ url, method: "PUT", headers, payload });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().capability, "monitoring-only");
    assert.equal(saved.json().permission, "read-write");
    for (const value of [payload.apiKey, payload.secret, payload.passphrase]) assert.ok(!saved.body.includes(value));
    const config = JSON.parse(await readFile(process.env.TERMINAL_CREDENTIALS_PATH, "utf8"));
    assert.equal(config.credentials.secret, payload.secret);
    if (process.platform !== "win32") assert.equal((await stat(process.env.TERMINAL_CREDENTIALS_PATH)).mode & 0o777, 0o600);
    const fetched = await app.inject({ url, headers });
    assert.equal(fetched.headers["cache-control"], "no-store");
    assert.equal(fetched.json().configured, true);
    assert.ok(!fetched.body.includes("fixture"));
    await writeFile(process.env.TERMINAL_STATE_PATH, JSON.stringify({ account: { equity: 10 }, equityHistory: [[1, 10]] }));
    const pending = (await app.inject({ url: "/api/terminal/state", headers })).json();
    assert.equal(pending.account, null);
    assert.equal(pending.accountStatus, "validating");
    assert.deepEqual(pending.equityHistory, []);
    await writeFile(process.env.TERMINAL_STATE_PATH, JSON.stringify({ connectionRevision: config.revision, account: { equity: 12 } }));
    assert.equal((await app.inject({ url: "/api/terminal/state", headers })).json().account.equity, 12);
    assert.equal((await app.inject({ url, method: "PUT", headers, payload: { permission: "read-only" } })).statusCode, 200);
    assert.equal(JSON.parse(await readFile(process.env.TERMINAL_CREDENTIALS_PATH, "utf8")).credentials.secret, payload.secret);
    assert.equal((await app.inject({ url, method: "DELETE", headers })).json().configured, false);
    assert.equal(JSON.parse(await readFile(process.env.TERMINAL_CREDENTIALS_PATH, "utf8")).credentials, null);
    assert.equal((await app.inject({ url: "/api/terminal/state", headers })).json().account, null);
    assert.equal((await app.inject({ url, method: "PUT", headers, payload: { permission: "read-only" } })).statusCode, 400);
    const control = "/api/terminal/control";
    assert.equal((await app.inject({ url: control, method: "PUT", payload: { paused: true } })).statusCode, 401);
    assert.equal((await app.inject({ url: control, method: "PUT", headers, payload: { paused: "false" } })).statusCode, 400);
    assert.equal((await app.inject({ url: control, method: "PUT", headers, payload: { paused: true } })).json().paused, true);
    const paused = (await app.inject({ url: "/api/terminal/state", headers })).json();
    assert.equal(paused.control.paused, true);
    assert.equal(paused.agents, null);
    assert.equal((await app.inject({ url: control, method: "PUT", headers, payload: { paused: false } })).json().paused, false);
  } finally {
    await app.close();
    if (oldPassword === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = oldPassword;
    if (oldPath === undefined) delete process.env.TERMINAL_STATE_PATH; else process.env.TERMINAL_STATE_PATH = oldPath;
    if (oldCredentialsPath === undefined) delete process.env.TERMINAL_CREDENTIALS_PATH; else process.env.TERMINAL_CREDENTIALS_PATH = oldCredentialsPath;
    if (oldControlPath === undefined) delete process.env.TERMINAL_CONTROL_PATH; else process.env.TERMINAL_CONTROL_PATH = oldControlPath;
    await rm(directory, { recursive: true, force: true });
  }
});
