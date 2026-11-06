const element = (id) => document.getElementById(id);
const definitions = [
  ["Scanner", "◫", "#ae7d31", "BTC and SOL · 1 hour"],
  ["Risk check", "△", "#ac526b", "Account and position visibility"],
  ["Sizer", "◇", "#7962b5", "2% risk reference"],
  ["Executor", "Ⅱ", "#39876d", "Order execution inactive"],
  ["Logger", "▤", "#b17f3b", "Connection and data events"],
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
  element("markets").replaceChildren(...["BTC", "SOL"].map((name) => {
    const market = markets.find((item) => item.symbol.startsWith(name + "/"));
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
    note.textContent = "USDT perpetual · Bitget";
    card.append(header, price, note);
    const history = market?.history?.map((point) => point[1]) ?? [];
    if (history.length > 1) {
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
  const stale = !state.updatedAt || Date.now() - state.updatedAt > 150_000;
  const account = state.account;
  element("freshness").textContent = state.updatedAt
    ? (stale ? "Stale data · " : "Updated ") + new Date(state.updatedAt).toLocaleTimeString() : "Waiting for market monitor";
  element("connection-title").textContent = state.accountStatus === "connected"
    ? "Bitget Classic account connected" : state.accountStatus === "unavailable" ? "Account connection unavailable" : "Market data connected · Account not connected";
  element("status").textContent = stale ? "Data is delayed. Check the market monitor connection." :
    state.accountStatus === "connected" ? "Balances and positions refresh automatically. Account access is read-only." :
    state.accountStatus === "unavailable" ? "Check the read-only API key and account permissions on the server." :
    "Add a Bitget Classic read-only API key on the server to display balances and positions.";
  element("equity").textContent = money(account?.equity);
  element("available").textContent = money(account?.available);
  element("count").textContent = account ? account.positions.length : "—";
  const pnl = account?.positions.reduce((sum, p) => sum + p.pnl, 0);
  element("pnl").textContent = money(pnl);
  element("equity-note").textContent = account ? "USDT · Real account" : "Account connection pending";
  element("footer-status").textContent = stale ? "Market data delayed" : "Market monitor online";
  const states = [stale ? "Data delayed" : state.markets.filter((m) => m.status === "connected").length + " / 2 markets connected",
    account ? account.positions.length + " open positions" : "Awaiting account connection",
    "Reference only", "Inactive · Read-only", state.logs.length + " recorded updates", account ? "Account synchronized" : "Awaiting account connection"];
  agentStates.forEach((node, index) => { node.textContent = states[index]; });
  renderMarkets(state.markets);
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
let busy = false;
let activeRequest;
function disconnect() {
  authorization = undefined;
  activeRequest?.abort();
  element("connect").hidden = false;
  element("disconnect").hidden = true;
  render({ updatedAt: null, account: null, accountStatus: "not-connected", markets: [], logs: [] });
  element("connection-title").textContent = "Connect your workspace";
  element("status").textContent = "Use your OpenTrader password to view market and account data.";
}
async function refresh() {
  if (!authorization || busy) return;
  busy = true;
  const usedAuthorization = authorization;
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
    if (authorization !== usedAuthorization) return;
    render(state);
    element("connect").hidden = true;
    element("disconnect").hidden = false;
  } catch (error) {
    if (authorization || error.message.startsWith("Password")) {
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
