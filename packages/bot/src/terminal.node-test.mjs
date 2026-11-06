import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { registerTerminal } from "./terminal.ts";

test("terminal protects account data and rejects mutations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "classic-terminal-"));
  const oldPassword = process.env.ADMIN_PASSWORD;
  const oldPath = process.env.TERMINAL_STATE_PATH;
  process.env.ADMIN_PASSWORD = "test-password";
  process.env.TERMINAL_STATE_PATH = join(directory, "state.json");
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
  } finally {
    await app.close();
    if (oldPassword === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = oldPassword;
    if (oldPath === undefined) delete process.env.TERMINAL_STATE_PATH; else process.env.TERMINAL_STATE_PATH = oldPath;
    await rm(directory, { recursive: true, force: true });
  }
});
