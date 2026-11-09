import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const COOLDOWN = 300_000;
const MAX_AGE = 900_000;
const reasons = new Set([
  "Fresh, complete hourly market data is required",
  "Watch only · enable Trade in Markets to evaluate entries",
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

// Only validated public hourly market facts enter analysis. No balances, credentials or raw logs.
export function analyzeMarkets(state, now = Date.now()) {
  if (!fresh(state, now)) return [];
  const latest = Math.floor(now / 3600000) * 3600000 - 3600000;
  const round = n => Number(n.toFixed(2));
  return (state.markets ?? []).filter(m => /^[A-Z0-9]{1,30}\/USDT:USDT$/.test(m.symbol) && m.status === 'connected').flatMap(m => {
    const h = m.history;
    if (m.candleTime !== latest || !Array.isArray(h) || h.length < 25 || h.length > 480 ||
      h.some((p,i) => !Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || p[1] <= 0 || (i && p[0]-h[i-1][0] !== 3600000)) ||
      h.at(-1)[0] !== latest || h.at(-1)[1] !== m.close ||
      ![m.close,m.lower,m.middle,m.upper,m.rsi].every(Number.isFinite) || m.lower <= 0 || m.middle < m.lower || m.upper < m.middle || m.rsi < 0 || m.rsi > 100) return [];
    const closes=h.map(p=>p[1]), range=closes.slice(-24);
    return [{symbol:m.symbol.split(':')[0],candleTime:latest,close:round(m.close),rsi:round(m.rsi),
      lower:round(m.lower),middle:round(m.middle),upper:round(m.upper),
      trend:m.close>m.middle?'above the 20-hour mean':m.close<m.middle?'below the 20-hour mean':'at the 20-hour mean',
      momentum:m.rsi>70?'overbought':m.rsi<30?'oversold':'neutral RSI range',
      bandPosition:m.close>m.upper?'above upper band':m.close<m.lower?'below lower band':'inside the bands',
      change6h:round((m.close/closes.at(-7)-1)*100),change24h:round((m.close/closes.at(-25)-1)*100),
      bandWidthPct:round((m.upper-m.lower)/m.middle*100),closingLow24h:round(Math.min(...range)),closingHigh24h:round(Math.max(...range))}];
  }).slice(0,25);
}
export function groundedMarketAnalysis(text, market) {
  if (!validText(text)) return false;
  const value = text.toLowerCase();
  const opposite = market.trend.startsWith('below') ? 'above' : market.trend.startsWith('above') ? 'below' : null;
  if (opposite && new RegExp(opposite + '.{0,45}(mean|average)').test(value)) return false;
  if (market.bandPosition === 'below lower band' && /above.{0,30}(band|bollinger)/.test(value)) return false;
  if (market.bandPosition === 'above upper band' && /below.{0,30}(band|bollinger)/.test(value)) return false;
  if (market.rsi >= 30 && market.rsi <= 70 && /overbought|oversold/.test(value)) return false;
  if (market.change6h < 0 && market.change24h < 0 && /positive (momentum|price change)|prices? (rose|rising|increased)/.test(value)) return false;
  return !/\b(buy now|sell now|guaranteed|will rise|will fall)\b/.test(value);
}
export function selectFacts(state, now = Date.now(), symbol) {
  return {
    analysis: analyzeMarkets(state, now),
    paused: state?.agents?.paused !== false,
    account: ["connected", "unavailable", "not-connected"].includes(state?.accountStatus) ? state.accountStatus : "unavailable",
    connectedMarkets: symbols.filter((symbol) => state?.markets?.some((m) => m.symbol === symbol && m.status === "connected")).length,
    activity: { minutes: 15, events: (state?.logs ?? []).slice(-100).filter((log) =>
      Number.isFinite(log.time) && log.time <= now && log.time >= now - MAX_AGE).length },
    decisions: (state?.agents?.decisions ?? []).filter((d) => symbol ? d.symbol === symbol + ":USDT" : symbols.includes(d.symbol)).slice(0, 2).map((d) => ({
      symbol: d.symbol.split(":")[0],
      status: d.execution?.status === "review" ? "preflight only; no order sent" : "no proposal ready",
      reason: reasons.has(d.execution?.reason) ? d.execution.reason : "Waiting for a supported code decision",
    })),
  };
}
function generationFacts(state, now, symbol) {
  const facts = selectFacts(state, now, symbol);
  facts.analysis = symbol ? facts.analysis.filter(market => market.symbol === symbol)
    : facts.analysis.filter(market => symbols.includes(market.symbol + ":USDT"));
  return facts;
}
function fingerprint(state, now, symbol) {
  const facts = generationFacts(state, now, symbol);
  if (symbol) { delete facts.activity; delete facts.decisions; }
  return createHash("sha256").update(JSON.stringify([state.connectionRevision ?? null, facts])).digest("hex");
}

export function presentCommentary(saved, state, settings, now = Date.now()) {
  const base = { enabled: settings?.enabled === true, model: "LFM2.5-1.2B", role: "analysis-only",
    selectedSymbol: settings?.symbol,
    facts: fresh(state, now) ? selectFacts(state, now, settings?.symbol) : null };
  if (!base.enabled) return { ...base, status: "disabled" };
  if (!fresh(state, now) || !state?.agents) return { ...base, status: "waiting" };
  if (!saved || saved.configRevision !== settings.revision || saved.fingerprint !== fingerprint(state, now, settings.symbol) ||
      !Number.isFinite(saved.updatedAt) || now - saved.updatedAt > 45_000 || saved.updatedAt > now + 5000) {
    return { ...base, status: "waiting" };
  }
  if (saved.status !== "ready" || !Number.isFinite(saved.generatedAt) || now - saved.generatedAt > MAX_AGE ||
      saved.generatedAt > now + 5000 || !validText(saved.summary) ||
      !Array.isArray(saved.explanations) || saved.explanations.length > 2 ||
      !saved.explanations.every((e) => (settings.symbol ? e.symbol === settings.symbol : ["BTC/USDT", "SOL/USDT"].includes(e.symbol)) && validText(e.text))) {
    return { ...base, status: ["generating", "unavailable"].includes(saved.status) ? saved.status : "waiting" };
  }
  return { ...base, status: "ready", generatedAt: saved.generatedAt, summary: saved.summary,
    explanations: saved.explanations.map(({ symbol, text }) => ({ symbol, text })),
    analysis: (saved.analysis ?? []).filter(e => base.facts?.analysis.some(m => m.symbol === e.symbol && groundedMarketAnalysis(e.text,m))).slice(0,2) };
}
function validText(text) {
  return typeof text === "string" && text.trim().length >= 8 && text.length <= 500 &&
    !/[<>\x00-\x08]/.test(text) && !/https?:\/\//i.test(text);
}

export function createAssistant({ readState, readSettings, write, generate, clock = Date.now, onDemand = false }) {
  let busy = false;
  let lastAttempt = -Infinity;
  let cached;
  let failureKey;
  let handledRequestAt;
  const pairCache = new Map();
  return { async tick() {
    if (busy) return;
    busy = true;
    try {
      const settings = await readSettings();
      const state = await readState();
      const now = clock();
      const key = fingerprint(state, now, settings.symbol);
      const decisionKey = onDemand ? JSON.stringify(generationFacts(state, now, settings.symbol).decisions) : undefined;
      const base = { updatedAt: now, fingerprint: key, configRevision: settings.revision, decisionKey };
      if (settings.enabled !== true) { cached = undefined; await write({ ...base, status: "disabled" }); return; }
      if (!fresh(state, now) || !state.agents) { await write({ ...base, status: "waiting" }); return; }
      if (cached?.fingerprint === key && cached.configRevision === settings.revision && cached.decisionKey === decisionKey &&
          now - cached.generatedAt < MAX_AGE - 30_000) {
        await write({ ...cached, updatedAt: now }); return;
      }
      if (onDemand) {
        const previous = pairCache.get(settings.symbol);
        if (previous?.fingerprint === key && previous.decisionKey === decisionKey && now - previous.generatedAt < MAX_AGE - 30_000) {
          handledRequestAt = settings.requestedAt;
          cached = { ...previous, ...base };
          await write(cached);
          return;
        }
        const requestAge = now - settings.requestedAt;
        if (!settings.symbol || !Number.isFinite(requestAge) || requestAge < -5000 || requestAge > 60000 ||
            handledRequestAt === settings.requestedAt || !generationFacts(state, now, settings.symbol).analysis.length) {
          await write({ ...base, status: failureKey === key ? "unavailable" : "waiting" });
          return;
        }
      }
      if (now - lastAttempt < (settings.symbol ? 10_000 : settings.requestedAt > lastAttempt ? 60_000 : COOLDOWN)) {
        await write({ ...base, status: failureKey === key ? "unavailable" : "waiting" }); return;
      }
      lastAttempt = now;
      if (onDemand) handledRequestAt = settings.requestedAt;
      await write({ ...base, status: "generating" });
      try {
        const facts = generationFacts(state, now, settings.symbol);
        const summary = onDemand ? "Explanation uses the recorded agent decision and the last closed hourly candle." :
          await generate("Rewrite the supplied activity update as one concise sentence. Keep every fact and number. No advice or introduction.",
          `Agents are ${facts.paused ? "paused" : "running"}. Account is ${facts.account.replaceAll("-", " ")}. ` +
          `${facts.connectedMarkets} markets are connected. ${facts.activity.events} updates were recorded in the last 15 minutes. Execution orders are tracked separately in Trade execution.`);
        const explanations = [];
        for (const decision of facts.decisions) {
          // Recheck between calls so disabling AI does not queue further work.
          if ((await readSettings()).revision !== settings.revision) break;
          const market = facts.analysis.find(item => item.symbol === decision.symbol);
          const readings = market ? ` Closed-hour RSI: ${market.rsi}. Bollinger position: ${market.bandPosition}.` : "";
          const text = await generate("Explain the supplied code decision in one short sentence. Preserve the recorded result. Do not recommend a trade.",
            `${decision.symbol}: ${decision.status}. The code decision is: ${decision.reason}.${readings}`);
          explanations.push({ symbol: decision.symbol, text });
        }
        const analysis = [];
        for (const market of facts.analysis) {
          if ((await readSettings()).revision !== settings.revision) break;
          const text = await generate("Summarize the close, bands and RSI in one sentence under 22 words. Preserve the exact above/below relationships and direction of changes. Use only supplied facts; no forecasts, recommendations or hypothetical scenarios.",
            `${market.symbol}: The completed hourly close is ${market.trend.toUpperCase()} and ${market.bandPosition.toUpperCase()}. RSI is ${market.rsi} (${market.momentum}). The 6-hour price change is ${market.change6h}%; the 24-hour change is ${market.change24h}%. Bollinger width is ${market.bandWidthPct}%. These are historical observations, not a prediction.`);
          if (groundedMarketAnalysis(text,market)) analysis.push({symbol:market.symbol,text});
        }
        if (!validText(summary) || !explanations.every((e) => validText(e.text))) throw new Error("Invalid commentary");
        const currentSettings = await readSettings();
        const current = await readState();
        if (!currentSettings.enabled || currentSettings.revision !== settings.revision) {
          cached = undefined;
          await write({ ...base, status: currentSettings.enabled ? "waiting" : "disabled" }); return;
        }
        if (!fresh(current, clock()) || fingerprint(current, clock(), settings.symbol) !== key ||
            (onDemand && JSON.stringify(generationFacts(current, clock(), settings.symbol).decisions) !== decisionKey)) {
          await write({ ...base, status: "waiting" }); return;
        }
        cached = { ...base, updatedAt: clock(), generatedAt: clock(), status: "ready", summary, explanations, analysis };
        if (onDemand) {
          pairCache.delete(settings.symbol);
          pairCache.set(settings.symbol, cached);
          if (pairCache.size > 25) pairCache.delete(pairCache.keys().next().value);
        }
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
    body: JSON.stringify({ model: "local", temperature: 0, max_tokens: 150, cache_prompt: false,
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
    onDemand: true,
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
