import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const COOLDOWN = 300_000;
const MAX_AGE = 900_000;
const reasons = new Set([
  "Fresh, complete hourly market data is required",
  "Waiting for a Bollinger band crossing and RSI below 30 or above 70",
  "Agents paused by operator",
  "A connected account with positive equity and available balance is required",
  "Existing positions need risk review before new exposure",
  "Price moved more than 1% from the signal close",
  "Exchange quantity rules are unavailable",
  "Remaining budget is below the exchange minimum order size",
  "Order proposal failed price, quantity or freshness validation",
  "Preflight passed · Live submission is not connected",
  "Preflight passed · Read-only key selected",
]);
const symbols = ["BTC/USDT:USDT", "SOL/USDT:USDT"];
const fresh = (state, now) => Number.isFinite(state?.updatedAt) && now - state.updatedAt >= -5000 && now - state.updatedAt <= 150_000;

// Explicit allowlist: raw logs, instructions, prices, balances and credentials never enter prompts.
export function selectFacts(state, now = Date.now()) {
  return {
    paused: state?.agents?.paused !== false,
    account: ["connected", "unavailable", "not-connected"].includes(state?.accountStatus) ? state.accountStatus : "unavailable",
    connectedMarkets: symbols.filter((symbol) => state?.markets?.some((m) => m.symbol === symbol && m.status === "connected")).length,
    activity: { minutes: 15, events: (state?.logs ?? []).slice(-100).filter((log) =>
      Number.isFinite(log.time) && log.time <= now && log.time >= now - MAX_AGE).length },
    decisions: (state?.agents?.decisions ?? []).filter((d) => symbols.includes(d.symbol)).slice(0, 2).map((d) => ({
      symbol: d.symbol.split(":")[0],
      status: d.execution?.status === "review" ? "preflight only; no order sent" : "no proposal ready",
      reason: reasons.has(d.execution?.reason) ? d.execution.reason : "Waiting for a supported code decision",
    })),
  };
}
function fingerprint(state, now) {
  return createHash("sha256").update(JSON.stringify([state.connectionRevision ?? null, selectFacts(state, now)])).digest("hex");
}

export function presentCommentary(saved, state, settings, now = Date.now()) {
  const base = { enabled: settings?.enabled === true, model: "LFM2.5-1.2B", role: "explanations-only",
    facts: fresh(state, now) ? selectFacts(state, now) : null };
  if (!base.enabled) return { ...base, status: "disabled" };
  if (!fresh(state, now) || !state?.agents) return { ...base, status: "waiting" };
  if (!saved || saved.configRevision !== settings.revision || saved.fingerprint !== fingerprint(state, now) ||
      !Number.isFinite(saved.updatedAt) || now - saved.updatedAt > 45_000 || saved.updatedAt > now + 5000) {
    return { ...base, status: "waiting" };
  }
  if (saved.status !== "ready" || !Number.isFinite(saved.generatedAt) || now - saved.generatedAt > MAX_AGE ||
      saved.generatedAt > now + 5000 || !validText(saved.summary) ||
      !Array.isArray(saved.explanations) || saved.explanations.length > 2 ||
      !saved.explanations.every((e) => ["BTC/USDT", "SOL/USDT"].includes(e.symbol) && validText(e.text))) {
    return { ...base, status: ["generating", "unavailable"].includes(saved.status) ? saved.status : "waiting" };
  }
  return { ...base, status: "ready", generatedAt: saved.generatedAt, summary: saved.summary,
    explanations: saved.explanations.map(({ symbol, text }) => ({ symbol, text })) };
}
function validText(text) {
  return typeof text === "string" && text.trim().length >= 8 && text.length <= 500 &&
    !/[<>\x00-\x08]/.test(text) && !/https?:\/\//i.test(text);
}

export function createAssistant({ readState, readSettings, write, generate, clock = Date.now }) {
  let busy = false;
  let lastAttempt = -Infinity;
  let cached;
  let failureKey;
  return { async tick() {
    if (busy) return;
    busy = true;
    try {
      const settings = await readSettings();
      const state = await readState();
      const now = clock();
      const key = fingerprint(state, now);
      const base = { updatedAt: now, fingerprint: key, configRevision: settings.revision };
      if (settings.enabled !== true) { cached = undefined; await write({ ...base, status: "disabled" }); return; }
      if (!fresh(state, now) || !state.agents) { await write({ ...base, status: "waiting" }); return; }
      if (cached?.fingerprint === key && cached.configRevision === settings.revision && now - cached.generatedAt < MAX_AGE - 30_000) {
        await write({ ...cached, updatedAt: now }); return;
      }
      if (now - lastAttempt < COOLDOWN) {
        await write({ ...base, status: failureKey === key ? "unavailable" : "waiting" }); return;
      }
      lastAttempt = now;
      await write({ ...base, status: "generating" });
      try {
        const facts = selectFacts(state, now);
        const summary = await generate("Rewrite the supplied activity update as one concise sentence. Keep every fact and number. No advice or introduction.",
          `Agents are ${facts.paused ? "paused" : "running"}. Account is ${facts.account.replaceAll("-", " ")}. ` +
          `${facts.connectedMarkets} markets are connected. ${facts.activity.events} updates were recorded in the last 15 minutes. The terminal submitted 0 orders.`);
        const explanations = [];
        for (const decision of facts.decisions) {
          // Recheck between calls so disabling AI does not queue further work.
          if ((await readSettings()).revision !== settings.revision) break;
          const text = await generate("Explain the supplied code decision in plain English in one short sentence. Mention the named indicators. Do not recommend a trade.",
            `${decision.symbol}: ${decision.status}. The code decision is: ${decision.reason}.`);
          explanations.push({ symbol: decision.symbol, text });
        }
        if (!validText(summary) || !explanations.every((e) => validText(e.text))) throw new Error("Invalid commentary");
        const currentSettings = await readSettings();
        const current = await readState();
        if (!currentSettings.enabled || currentSettings.revision !== settings.revision) {
          cached = undefined;
          await write({ ...base, status: currentSettings.enabled ? "waiting" : "disabled" }); return;
        }
        if (!fresh(current, clock()) || fingerprint(current, clock()) !== key) {
          await write({ ...base, status: "waiting" }); return;
        }
        cached = { ...base, updatedAt: clock(), generatedAt: clock(), status: "ready", summary, explanations };
        failureKey = undefined;
        await write(cached);
      } catch {
        failureKey = key;
        await write({ ...base, updatedAt: clock(), status: "unavailable" });
      }
    } finally { busy = false; }
  } };
}

export async function generateLocal(instruction, facts, { fetchImpl = fetch, timeout = 12_000 } = {}) {
  // Fixed loopback destination, optionally backed by the restricted SSH link to proud-server.
  // No exchange client, trading tools or user-selectable destination.
  const response = await fetchImpl("http://127.0.0.1:18089/v1/chat/completions", {
    method: "POST", signal: AbortSignal.timeout(timeout), headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "local", temperature: 0, max_tokens: 90, cache_prompt: false,
      messages: [{ role: "system", content: instruction },
        { role: "user", content: typeof facts === "string" ? facts : JSON.stringify(facts) }], chat_template_kwargs: { enable_thinking: false } }),
  });
  if (!response.ok) throw new Error("Local explanation unavailable");
  const result = await response.json();
  const text = result.choices?.[0]?.message?.content?.trim();
  if (result.choices?.[0]?.finish_reason !== "stop" || !validText(text)) throw new Error("Incomplete explanation");
  return text;
}

async function runWorker() {
  const directory = process.env.TERMINAL_ASSISTANT_PATH ?? "/assistant";
  const statePath = process.env.TERMINAL_STATE_PATH ?? "/terminal/state.json";
  const readSettings = async () => {
    try { return JSON.parse(await readFile(directory + "/settings.json", "utf8")); }
    catch { return { enabled: false }; }
  };
  const worker = createAssistant({
    readState: async () => JSON.parse(await readFile(statePath, "utf8")), readSettings, generate: generateLocal,
    write: async (value) => {
      const filename = directory + "/commentary.json";
      await mkdir(dirname(filename), { recursive: true });
      const temporary = filename + "." + randomUUID() + ".tmp";
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      await rename(temporary, filename);
    },
  });
  while (true) {
    try { await worker.tick(); }
    catch { console.error("Commentary waiting for a readable snapshot."); }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWorker().catch(() => { console.error("Commentary worker stopped."); process.exitCode = 1; });
}
