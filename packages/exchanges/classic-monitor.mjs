import { bitget } from "ccxt";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { runAgents } from "./classic-agents.mjs";
import { createBitgetV3 } from './terminal-bitget-v3.mjs';
import { createMarketFeed } from './terminal-market-feed.mjs';
import { readMarkets, catalogPath } from './terminal-markets.mjs';
import { readJson, atomicJson } from './terminal-trading-store.mjs';

const allowed = new Set(["v2/mix/account/accounts", "v2/mix/position/all-position"]);

export async function readClassic(exchange, endpoint) {
  if (!allowed.has(endpoint)) throw new Error("Unsupported account read");
  const params = { productType: "USDT-FUTURES", marginCoin: "USDT" };
  const signed = exchange.sign(endpoint, ["private", "mix"], "GET", params);
  if (new URL(signed.url).origin !== "https://api.bitget.com" || signed.method !== "GET") {
    throw new Error("Unexpected account routing");
  }
  const result = await exchange.request(endpoint, ["private", "mix"], "GET", params);
  if (result.code !== "00000") throw new Error("Account read rejected");
  return result.data;
}

export { summarizeCandles } from "./terminal-candles.mjs";

export async function readAccountConfig(filename) {
  try {
    const config = JSON.parse(await readFile(filename, "utf8"));
    if (typeof config.revision !== "string" || !["read-only", "read-write"].includes(config.permission) ||
        !['v2', 'v3'].includes(config.apiVersion ?? 'v2') || !['demo', 'live'].includes(config.environment ?? 'live') ||
        (config.credentials !== null && !["apiKey", "secret", "passphrase"].every((key) =>
          typeof config.credentials?.[key] === "string" && config.credentials[key].length > 0))) {
      throw new Error("Invalid connection settings");
    }
    return config;
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("Connection settings unavailable");
    const { BITGET_API_KEY, BITGET_SECRET_KEY, BITGET_PASSPHRASE } = process.env;
    return { revision: null, permission: "read-only", credentials:
      BITGET_API_KEY && BITGET_SECRET_KEY && BITGET_PASSPHRASE
        ? { apiKey: BITGET_API_KEY, secret: BITGET_SECRET_KEY, passphrase: BITGET_PASSPHRASE } : null };
  }
}

export async function monitor() {
  const filename = process.env.TERMINAL_STATE_PATH ?? "/app/data/terminal/state.json";
  await mkdir(dirname(filename), { recursive: true });
  const options = { enableRateLimit: true, timeout: 12_000 };
  const cachePath = filename + '.candles.json';
  let cache = {};
  try { cache = await readJson(cachePath, {}); } catch { /* Rebuild a damaged public-data cache. */ }
  const pricing = createMarketFeed({ cache });
  let previous = {};
  try { previous = JSON.parse(await readFile(filename, "utf8")); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const logs = previous.logs ?? [];
  const history = previous.equityHistory ?? [];
  let connectionRevision = previous.connectionRevision;
  let lastStatus;
  let lastDecision;
  while (true) {
    let config;
    let configError = false;
    try { config = await readAccountConfig(process.env.TERMINAL_CREDENTIALS_PATH ?? "/app/data/terminal/bitget.json"); }
    catch { configError = true; config = { revision: null, credentials: null }; }
    if (config.revision !== connectionRevision || configError) history.length = 0;
    connectionRevision = config.revision;
    const accountClient = config.credentials ? new bitget({ ...options, apiKey: config.credentials.apiKey,
      secret: config.credentials.secret, password: config.credentials.passphrase }) : null;
    if (config.environment === 'demo') accountClient?.setSandboxMode(true);
    const state = { updatedAt: Date.now(), mode: "classic-v2", access: "read-only", markets: [],
      connectionRevision, account: null, accountStatus: accountClient || configError ? "unavailable" : "not-connected", logs, equityHistory: history };
    try {
      const selection = await readMarkets();
      const snapshot = await pricing.snapshot(selection.pairs);
      state.markets = snapshot.markets; state.marketRevision = selection.revision; state.scanStats = snapshot.stats;
      await atomicJson(catalogPath(), snapshot.catalog);
      if (snapshot.stats.candles) await atomicJson(cachePath, pricing.cache());
    } catch { state.marketError = 'Market scan unavailable; new entries are blocked.'; }
    if (accountClient) {
      try {
        let balances, positions;
        if (config.apiVersion === 'v3') {
          const unified = createBitgetV3(config.environment ?? 'live', config.credentials);
          const assets = await unified.request('GET', 'account/assets');
          const coin = assets.assets.find((item) => item.coin === 'USDT');
          balances = [{ marginCoin: 'USDT', usdtEquity: assets.usdtEquity, available: coin?.available ?? 0 }];
          positions = await unified.positions();
        } else {
          balances = await readClassic(accountClient, "v2/mix/account/accounts");
          positions = await readClassic(accountClient, "v2/mix/position/all-position");
        }
        const usdt = balances.find((item) => item.marginCoin === "USDT");
        const equity = Number(usdt?.usdtEquity);
        const available = Number(usdt?.available);
        if (!Number.isFinite(equity) || !Number.isFinite(available)) throw new Error("Missing account values");
        state.account = { equity, available, positions: positions.filter((p) => Number(p.total) > 0).map((p) => ({
          symbol: p.symbol, side: p.holdSide, quantity: Number(p.total), pnl: Number(p.unrealizedPL),
        })) };
        state.accountStatus = "connected";
        history.push([Date.now(), equity]);
        if (history.length > 480) history.shift();
      } catch { state.accountStatus = "unavailable"; }
    }
    let paused = false;
    try {
      const controls = JSON.parse(await readFile(process.env.TERMINAL_CONTROL_PATH ?? "/credentials/control.json", "utf8"));
      paused = controls.paused !== false;
    } catch (error) { if (error.code !== "ENOENT") paused = true; }
    state.agents = runAgents(state, { permission: config.permission, paused });
    const decision = JSON.stringify(state.agents.decisions.map((item) =>
      [item.symbol, item.scan.status, item.risk.reason, item.size.status, item.execution.reason]));
    if (decision !== lastDecision) {
      for (const item of state.agents.decisions) logs.push({ time: Date.now(), message:
        `${item.symbol.split(":")[0]} · Risk: ${item.risk.status} · ${item.execution.reason}` });
      lastDecision = decision;
    }
    const status = state.markets.map((m) => m.symbol.split("/")[0] + " " + m.status).join(" · ") +
      " · Account " + state.accountStatus;
    if (status !== lastStatus) {
      logs.push({ time: Date.now(), message: status });
      lastStatus = status;
    }
    if (logs.length > 100) logs.splice(0, logs.length - 100);
    state.updatedAt = Date.now();
    await writeFile(filename + ".tmp", JSON.stringify(state), { mode: 0o600 });
    await rename(filename + ".tmp", filename);
    if (process.argv.includes("--once")) return state;
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  monitor().catch(() => { console.error("Classic market monitor stopped. Check its state volume and network."); process.exitCode = 1; });
}
