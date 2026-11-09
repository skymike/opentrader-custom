import { createTradingPanel } from './trading.js';
import { createManualFuturesPanel } from './manual-futures.js';
import { createConnectionsPanel } from './connections.js';
import { createMarketsPanel } from './markets.js';
const element = (id) => document.getElementById(id);
const definitions = [
  ["Scanner", "◫", "#ae7d31", "Watched pairs · 1 hour"],
  ["Risk check", "△", "#ac526b", "Freshness, exposure and account limits"],
  ["Sizer", "◇", "#7962b5", "2% risk · Exchange quantity rules"],
  ["Executor", "Ⅱ", "#39876d", "Order preflight · No live submission"],
  ["Logger", "▤", "#b17f3b", "Decisions and connection events"],
  ["Equity", "◈", "#3c73b8", "Classic USDT account"],
];
const agentStates = definitions.map(([name, icon, color, description]) => {
  const card = document.createElement("article");
  card.style.setProperty("--agent", color);
  const heading = document.createElement("div");
  heading.className = "agent-name";
  const badge = document.createElement("span");
  badge.className = "agent-icon";
  badge.textContent = icon;
  const title = document.createElement("h2");
  title.textContent = name;
  heading.append(badge, title);
  const state = document.createElement("div");
  state.className = "agent-state";
  state.textContent = "Waiting for connection";
  const detail = document.createElement("p");
  detail.className = "agent-description";
  detail.textContent = description;
  card.append(heading, state, detail);
  element("agents").append(card);
  return state;
});
const format = (value, digits = 2) => Number.isFinite(value)
  ? value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits }) : "—";
const money = (value) => Number.isFinite(value) ? "$" + format(value) : "—";
const svgNamespace = "http://www.w3.org/2000/svg";
function chartPoints(values) {
  const low = Math.min(...values);
  const range = Math.max(...values) - low;
  return values.map((value, index) => [5 + 590 * index / (values.length - 1),
    range ? 90 - 80 * (value - low) / range : 50].join(",")).join(" ");
}
function renderMarkets(markets) {
  element("markets").replaceChildren(...markets.map((market) => {
    const name = market.symbol.split('/')[0];
    const card = document.createElement("article");
    const header = document.createElement("div");
    header.className = "market-head";
    const title = document.createElement("strong");
    title.textContent = name + " / USDT";
    const change = document.createElement("span");
    change.className = "change " + (market?.change < 0 ? "negative" : "positive");
    change.textContent = Number.isFinite(market?.change) ? format(market.change) + "% · 24h" : "Awaiting data";
    header.append(title, change);
    const price = document.createElement("div");
    price.className = "market-price";
    price.textContent = money(market?.price);
    const note = document.createElement("small");
    note.textContent = market.trade ? "Trade enabled · USDT perpetual" : "Watch only · USDT perpetual";
    card.append(header, price, note);
    const history = market?.history?.map((point) => point[1]) ?? [];
    if (history.length > 1 && markets.length <= 2) {
      const svg = document.createElementNS(svgNamespace, "svg");
      svg.setAttribute("viewBox", "0 0 600 100");
      svg.setAttribute("class", "market-chart");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", name + " hourly closing prices");
      const line = document.createElementNS(svgNamespace, "polyline");
      line.setAttribute("points", chartPoints(history));
      line.setAttribute("fill", "none");
      line.setAttribute("stroke", "currentColor");
      line.setAttribute("stroke-width", "3");
      svg.append(line);
      card.append(svg);
    }
    const indicators = document.createElement("div");
    indicators.className = "indicators";
    for (const [label, value] of [["RSI · 14", format(market?.rsi, 1)],
      ["Bollinger · 20 / 2", format(market?.lower) + " – " + format(market?.upper)]]) {
      const cell = document.createElement("div");
      cell.textContent = label;
      const text = document.createElement("b");
      text.textContent = value;
      cell.append(text);
      indicators.append(cell);
    }
    card.append(indicators);
    return card;
  }));
}
function render(state) {
  lastState = state;
  const stale = !state.updatedAt || Date.now() - state.updatedAt > 150_000;
  const account = state.account;
  element("freshness").textContent = state.updatedAt
    ? (stale ? "Stale data · " : "Updated ") + new Date(state.updatedAt).toLocaleTimeString() : "Waiting for market monitor";
  element("connection-title").textContent = state.accountStatus === "connected"
    ? `Bitget ${state.connection?.apiVersion ?? 'v2'} ${(state.connection?.environment ?? 'live').toUpperCase()} account connected` : state.accountStatus === "unavailable" ? "Account connection unavailable" : "Market data connected · Account not connected";
  element("status").textContent = stale ? "Data is delayed. Check the market monitor connection." :
    state.accountStatus === "connected" ? "Balances and positions refresh automatically. Account access is read-only." :
    state.accountStatus === "unavailable" ? "Open Settings → Bitget connection to check your credentials, permissions and IP allowlist." :
    state.accountStatus === "validating" ? "Connection saved. Waiting for the next account check, usually within 90 seconds." :
    "Open Settings → Bitget connection to add your API key, secret and passphrase.";
  if (state.connection) {
    connectionConfig = state.connection;
    connections.update(state.connection);
    if (!element("settings-dialog").open) element("settings-status").textContent = state.accountStatus === "connected" ? "Connected · Balances and positions are updating." :
      state.accountStatus === "validating" ? "Saved · Waiting for the next account check (up to 90 seconds)." :
      state.accountStatus === "unavailable" ? "Unable to connect. Check all three credentials, futures read permissions and your Bitget IP allowlist." :
      "No account connected. Add your Bitget credentials below.";
  }
  element("equity").textContent = money(account?.equity);
  element("available").textContent = money(account?.available);
  element("count").textContent = account ? account.positions.length : "—";
  const pnl = account?.positions.reduce((sum, p) => sum + p.pnl, 0);
  element("pnl").textContent = money(pnl);
  element("equity-note").textContent = account ? `USDT · ${(state.connection?.environment ?? 'live').toUpperCase()} account` : "Account connection pending";
  element("footer-status").textContent = stale ? "Market data delayed" : "Market monitor online";
  const selectedMarket = state.markets.find(market => market.symbol.split(":")[0] === selectedAnalysisSymbol);
  const decisions = (state.agents?.decisions ?? []).filter(decision => decision.symbol.split(":")[0] === selectedAnalysisSymbol);
  const paused = state.control?.paused ?? state.agents?.paused ?? false;
  element("pause-agents").textContent = paused ? "Resume agents" : "Pause agents";
  element("pause-agents").disabled = !authorization;
  element("agent-control-status").textContent = paused ? "Agents paused. Market and account monitoring continue. Existing exchange positions are unchanged."
    : "Order proposals only. Pausing prevents new proposals; it does not close exchange positions.";
  element("agent-decisions").replaceChildren(...decisions.map((decision) => {
    const card = document.createElement("section");
    const heading = document.createElement("h3");
    heading.textContent = decision.symbol.split(":")[0];
    card.append(heading);
    for (const [label, result] of [["Signal", decision.scan], ["Risk", decision.risk], ["Size", decision.size], ["Executor", decision.execution]]) {
      const line = document.createElement("p");
      const name = document.createElement("strong");
      name.textContent = label + " · " + result.status;
      line.append(name, document.createElement("br"), document.createTextNode(result.reason));
      card.append(line);
    }
    if (decision.size.status === "sized") {
      const plan = decision.size;
      const detail = document.createElement("p");
      detail.className = "proposal";
      detail.textContent = `${plan.side.toUpperCase()} ${format(plan.quantity, 6)} · Entry ${money(plan.entry)} · SL ${money(plan.stop)} · TP ${money(plan.target)} · Estimated stop risk ${money(plan.riskAmount)} before fees/slippage`;
      card.append(detail);
    }
    return card;
  }));
  if (!decisions.length) element("agent-decisions").textContent = paused ? "Agents paused. No active proposals." : "Waiting for the next agent evaluation.";
  const readiness = paused ? "Paused" : stale ? "Data delayed" : !decisions.length ? "Awaiting evaluation" : null;
  const states = [stale ? "Data delayed" : selectedAnalysisSymbol + (selectedMarket?.status === "connected" ? " · Connected" : " · Awaiting data"),
    readiness ?? decisions.filter((d) => d.risk.status === "passed").length + " / " + decisions.length + " checks passed",
    readiness ?? decisions.filter((d) => d.size.status === "sized").length + " proposals sized",
    readiness ?? decisions.filter((d) => d.execution.status === "review").length + " ready for review · No orders",
    state.logs.length + " recorded updates", account ? "Account synchronized" : "Awaiting account connection"];
  agentStates.forEach((node, index) => { node.textContent = states[index]; });
  renderMarkets(selectedMarket ? [selectedMarket] : []);
  markets.update(state);
  const history = state.equityHistory?.map((point) => point[1]) ?? [];
  element("curve").toggleAttribute("hidden", history.length < 2);
  element("chart-empty").hidden = history.length >= 2;
  if (history.length >= 2) element("curve").querySelector("polyline").setAttribute("points", chartPoints(history));
  element("positions").replaceChildren(...(account?.positions ?? []).map((position) => {
    const row = document.createElement("tr");
    for (const value of [position.symbol, position.side, format(position.quantity, 6), money(position.pnl)]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    return row;
  }));
  element("positions-empty").hidden = !!account?.positions.length;
  element("positions-empty").textContent = account ? "No open USDT futures positions." : "Connect a read-only Bitget key to view positions.";
  element("logs").replaceChildren(...state.logs.slice().reverse().map((entry) => {
    const row = document.createElement("li");
    const time = document.createElement("time");
    time.dateTime = new Date(entry.time).toISOString();
    time.textContent = new Date(entry.time).toLocaleTimeString();
    row.append(time, document.createTextNode(entry.message));
    return row;
  }));
  element("logs-empty").hidden = state.logs.length > 0;
}
let authorization;
// A protected gateway may supply the backend credential without exposing it to this page.
// Run after module initialization so all existing controls keep their normal lifecycle.
queueMicrotask(async () => {
  try {
    const response = await fetch('/api/terminal/state', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok || authorization) return;
    authorization = 'portal-session';
    await refresh();
  } catch { /* Retain manual login when no authenticated gateway is available. */ }
});
createManualFuturesPanel(() => authorization, () => trading.refresh());
const trading = createTradingPanel(() => authorization, value => connections.updateExecution(value));
const markets = createMarketsPanel(() => authorization, () => { void trading.refresh(); void refresh(); });
let busy = false;
let activeRequest;
let connectionConfig;
let lastState;
let connectionGeneration = 0;
const connections = createConnectionsPanel(() => authorization, result => {
  const changed = connectionConfig?.revision !== result.revision;
  connectionGeneration++;
  connectionConfig = result;
  if (changed) {
    clearAssistant();
    render({ ...lastState, updatedAt: lastState?.updatedAt ?? null, markets: lastState?.markets ?? [], logs: lastState?.logs ?? [],
      account: null, equityHistory: [], agents: null, accountStatus: result.configured ? 'validating' : 'not-connected', connection: result });
  }
  void refresh();
}, environment => trading.editConnection(environment));
function disconnect() {
  authorization = undefined;
  connections.clear();
  trading.clear();
  markets.clear();
  clearAssistant();
  activeRequest?.abort();
  connectionConfig = undefined;
  element("settings-form").reset();
  element("settings-fields").disabled = true;
  element("settings-status").textContent = "Sign in to your workspace first.";
  element("connect").hidden = false;
  element("disconnect").hidden = true;
  render({ updatedAt: null, account: null, accountStatus: "not-connected", markets: [], logs: [] });
  element("connection-title").textContent = "Connect your workspace";
  element("status").textContent = "Use your OpenTrader password to view market and account data.";
}
async function refresh() {
  if (!authorization || busy) return;
  void trading.refresh();
  busy = true;
  const usedAuthorization = authorization;
  const usedGeneration = connectionGeneration;
  element("connect-button").disabled = true;
  activeRequest = new AbortController();
  const timeout = setTimeout(() => activeRequest?.abort(), 15_000);
  try {
    const response = await fetch("/api/terminal/state", { headers: { authorization }, signal: activeRequest.signal });
    if (response.status === 401) {
      disconnect();
      throw new Error("Password not accepted. Use your OpenTrader admin password.");
    }
    if (!response.ok) throw new Error("The market monitor is unavailable. Retrying shortly.");
    const state = await response.json();
    if (authorization !== usedAuthorization || connectionGeneration !== usedGeneration) return;
    render(state);
    connections.start();
    markets.start();
    void refreshAssistant();
    element("connect").hidden = true;
    element("disconnect").hidden = false;
  } catch (error) {
    if (authorization || error.message.startsWith("Password")) {
      clearAssistant();
      element("status").textContent = error.name === "AbortError" ? "Connection timed out. Retrying shortly." : error.message;
      element("freshness").textContent = "Connection interrupted · Displayed data may be stale";
    }
  } finally {
    clearTimeout(timeout);
    busy = false;
    element("connect-button").disabled = false;
  }
}
element("connect").addEventListener("submit", (event) => {
  event.preventDefault();
  authorization = element("password").value;
  element("password").value = "";
  void refresh();
});
element("disconnect").addEventListener("click", disconnect);
renderMarkets([]);
setInterval(() => void refresh(), 10_000);

function updateTheme() {
  const dark = document.documentElement.dataset.theme === "dark";
  element("theme-toggle").textContent = dark ? "☀ Light mode" : "☾ Dark mode";
  element("theme-toggle").setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
}
element("theme-toggle").addEventListener("click", () => {
  const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem("terminal-theme", theme); } catch { /* The toggle still works with storage disabled. */ }
  updateTheme();
});
updateTheme();
if (location.hash === "#settings") connections.open();
element("pause-agents").addEventListener("click", async () => {
  if (!authorization) return;
  element("pause-agents").disabled = true;
  try {
    const response = await fetch("/api/terminal/control", { method: "PUT", headers: { authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ paused: !(lastState?.control?.paused ?? false) }), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error("Could not update agent controls. Please try again.");
    const control = await response.json();
    connectionGeneration++;
    clearAssistant();
    render({ ...lastState, control, agents: null });
  } catch (error) { element("agent-control-status").textContent = error.message; }
  finally { element("pause-agents").disabled = !authorization; }
});

// AI reads are independent of market refreshes. Neither route invokes inference.
let assistantEnabled = false;
let assistantRequest;
let assistantBusy = false;
let assistantSaving = false;
let selectedAnalysisSymbol = "BTC/USDT";
let assistantData;
document.addEventListener("terminal-market-select", ({ detail }) => {
  if (!/^[A-Z0-9]{1,30}USDT$/.test(detail?.symbol ?? "")) return;
  selectedAnalysisSymbol = detail.symbol.slice(0, -4) + "/USDT";
  if (assistantData) renderAssistant(assistantData);
  if (lastState) render(lastState);
});
function renderMarketAnalysis(data) {
  const panel = element("ai-market-analysis");
  const section = document.createElement("section");
  const title = document.createElement("h3");
  title.textContent = selectedAnalysisSymbol + " · Last closed 1h candle";
  section.append(title);
  const fact = data.facts?.analysis?.find(item => item.symbol === selectedAnalysisSymbol);
  const reading = document.createElement("p");
  if (fact) {
    const evidence = document.createElement("p");
    evidence.className = "analysis-evidence";
    evidence.textContent = "RSI " + fact.rsi + " · 24h " + (fact.change24h > 0 ? "+" : "") + fact.change24h + "%";
    section.append(evidence);
    const generated = data.analysis?.find(item => item.symbol === selectedAnalysisSymbol)?.text;
    reading.textContent = generated ?? (fact.trend + " · " + fact.bandPosition + ".");
    if (generated) {
      reading.className = "short-ai-reading";
      reading.title = generated;
    }
  } else {
    reading.textContent = "Waiting for complete hourly data.";
  }
  section.append(reading);
  panel.replaceChildren(section);
}
function clearAssistant() {
  assistantData = undefined;
  clearTimeout(selectionTimer);
  element('ai-market-analysis').replaceChildren();
  element('ai-analyse').disabled = !authorization;
  assistantRequest?.abort();
  element("ai-summary").hidden = true;
  element("ai-summary").textContent = "";
  element("ai-explanations").replaceChildren();
  element("ai-facts").textContent = "";
  element("ai-time").textContent = "";
  element("ai-status").textContent = authorization ? "Waiting for current commentary…" : "Sign in to view AI commentary.";
  element("ai-toggle").disabled = !authorization;
}
function renderAssistant(data) {
  element('ai-analyse').disabled = !authorization || assistantSaving;
  assistantData = data;
  renderMarketAnalysis(data);
  assistantEnabled = data.enabled;
  element("ai-toggle").textContent = data.enabled ? "Turn AI off" : "Enable AI commentary";
  element("ai-toggle").setAttribute("aria-pressed", String(data.enabled));
  element("ai-toggle").disabled = !authorization || assistantSaving;
  const messages = { ready: "AI analysis ready",
    disabled: "AI is off. Calculated market facts remain available.",
    generating: "Writing AI analysis…",
    waiting: "Choose Analyze this pair or Explain this decision to request AI.",
    unavailable: "AI is temporarily unavailable. You can request it again in a minute." };
  element("ai-status").textContent = messages[data.status] ?? messages.unavailable;
  element("ai-summary").textContent = data.summary ?? "";
  element("ai-summary").hidden = !data.summary;
  element("ai-time").textContent = data.generatedAt ? "Written " + new Date(data.generatedAt).toLocaleTimeString() : "";
  element("ai-facts").textContent = data.facts ? `${data.facts.activity.events} recorded updates in the last 15 minutes · Selected pair: ${selectedAnalysisSymbol} · Account ${data.facts.account}${data.facts.paused ? " · Agents paused" : ""}` : "";
  element("ai-explanations").replaceChildren(...(data.facts?.decisions ?? []).filter(decision => decision.symbol === selectedAnalysisSymbol).map((decision) => {
    const section = document.createElement("section");
    const heading = document.createElement("h3");
    heading.textContent = decision.symbol;
    section.append(heading);
    const explanation = data.explanations?.find((item) => item.symbol === decision.symbol);
    if (explanation) {
      const text = document.createElement("p");
      text.textContent = explanation.text;
      section.append(text);
    }
    const source = document.createElement("p");
    source.className = "ai-source";
    source.textContent = "Recorded code decision: " + decision.reason;
    section.append(source);
    return section;
  }));
}
async function refreshAssistant() {
  if (!authorization || assistantBusy || assistantSaving) return;
  assistantBusy = true;
  const usedAuthorization = authorization;
  const generation = connectionGeneration;
  assistantRequest = new AbortController();
  const timer = setTimeout(() => assistantRequest?.abort(), 4000);
  try {
    const response = await fetch("/api/terminal/assistant", { headers: { authorization }, signal: assistantRequest.signal });
    if (!response.ok) throw new Error("Commentary unavailable");
    const data = await response.json();
    if (authorization === usedAuthorization && generation === connectionGeneration) renderAssistant(data);
  } catch {
    if (authorization === usedAuthorization && generation === connectionGeneration) {
      clearAssistant();
      element("ai-status").textContent = "Commentary is temporarily unavailable. Market monitoring continues.";
    }
  } finally { clearTimeout(timer); assistantBusy = false; }
}
element("ai-toggle").addEventListener("click", async () => {
  if (!authorization || assistantSaving) return;
  assistantSaving = true;
  const usedAuthorization = authorization;
  connectionGeneration++;
  clearAssistant();
  element("ai-toggle").disabled = true;
  try {
    const response = await fetch("/api/terminal/assistant", { method: "PUT", headers: { authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !assistantEnabled }), signal: AbortSignal.timeout(5000) });
    if (authorization !== usedAuthorization) return;
    if (!response.ok) throw new Error("Could not save AI settings. Please try again.");
    const data = await response.json();
    renderAssistant({ ...data, status: data.enabled ? "waiting" : "disabled" });
  } catch (error) {
    if (authorization === usedAuthorization) element("ai-status").textContent = error.message;
  } finally {
    assistantSaving = false;
    element("ai-toggle").disabled = !authorization;
    void refreshAssistant();
  }
});

const analyzePair = element("ai-analyse");
analyzePair.textContent = "Analyze this pair";
const explainDecision = document.createElement("button");
explainDecision.className = "secondary";
explainDecision.type = "button";
explainDecision.textContent = "Explain this decision";
analyzePair.after(explainDecision);

async function requestAnalysis(tabIndex) {
  if (!authorization || assistantSaving) return;
  const symbol = selectedAnalysisSymbol;
  const status = element("ai-status");
  if (!assistantData?.facts?.analysis?.some(market => market.symbol === symbol)) {
    status.textContent = "This pair needs a complete, current hourly candle history.";
    return;
  }
  document.querySelectorAll(".analysis-tabs [aria-pressed]")[tabIndex]?.click();
  if (assistantData.status === "ready" && assistantData.selectedSymbol === symbol) return;
  const auth = authorization;
  assistantSaving = true;
  connectionGeneration++;
  analyzePair.disabled = explainDecision.disabled = true;
  try {
    const response = await fetch("/api/terminal/assistant", {
      method: "PUT",
      headers: { authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, requestAnalysis: true, symbol }),
      signal: AbortSignal.timeout(5000),
    });
    if (auth !== authorization) return;
    const data = await response.json();
    if (!response.ok) throw new Error(data.message ?? "Could not request AI.");
    assistantEnabled = data.enabled;
    status.textContent = "AI requested for " + symbol + ".";
  } catch (error) {
    if (auth === authorization) status.textContent = error.message;
  } finally {
    assistantSaving = false;
    analyzePair.disabled = explainDecision.disabled = !authorization;
  }
}
analyzePair.addEventListener("click", () => void requestAnalysis(0));
explainDecision.addEventListener("click", () => void requestAnalysis(1));
