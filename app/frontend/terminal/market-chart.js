import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
} from "./vendor/lightweight-charts.mjs";
import { normalizeCandles, indicators } from "./chart-data.js";
import { botOverlays } from "./bot-overlays.js";
const el = (id) => document.getElementById(id);
const chart = createChart(el("price-chart"), {
  autoSize: true,
  layout: { attributionLogo: true },
  timeScale: { timeVisible: true, secondsVisible: false },
  rightPriceScale: { borderVisible: false },
  crosshair: { mode: 0 },
});
const candles = chart.addSeries(CandlestickSeries, {
  upColor: "#22b997",
  downColor: "#f16b7a",
  wickUpColor: "#22b997",
  wickDownColor: "#f16b7a",
  borderVisible: false,
});
const bands = ["#458cff", "#91b5e9", "#458cff"].map((color) =>
  chart.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
);
const volume = chart.addSeries(
  HistogramSeries,
  { priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false },
  1,
);
const rsi = chart.addSeries(
  LineSeries,
  {
    color: "#b499f5",
    lineWidth: 1,
    priceLineVisible: false,
    title: "RSI 14",
    autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
  },
  2,
);
for (const price of [30, 70])
  rsi.createPriceLine({ price, color: "#77829a", lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
function resize() {
  const height = el("price-chart").clientHeight;
  chart.panes()[1]?.setHeight(Math.max(42, height * 0.14));
  chart.panes()[2]?.setHeight(Math.max(55, height * 0.18));
}
new ResizeObserver(resize).observe(el("price-chart"));
function theme() {
  const dark = document.documentElement.dataset.theme === "dark";
  chart.applyOptions({
    layout: {
      background: { type: "solid", color: dark ? "#101b2b" : "#ffffff" },
      textColor: dark ? "#acbdd3" : "#52647c",
      fontSize: 11,
    },
    grid: { vertLines: { color: dark ? "#1b2b40" : "#edf1f7" }, horzLines: { color: dark ? "#1b2b40" : "#edf1f7" } },
  });
}
theme();
new MutationObserver(theme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
let symbol = "BTCUSDT",
  interval = "1H",
  generation = 0,
  rows = [],
  socket,
  request,
  ping,
  reconnect,
  poll,
  lastUpdate = 0,
  streaming = false,
  streamRevision = 0;
function draw(fit = false) {
  candles.setData(rows);
  volume.setData(
    rows.map((c) => ({ time: c.time, value: c.volume, color: c.close >= c.open ? "#22b99780" : "#f16b7a80" })),
  );
  const data = indicators(rows);
  [data.upper, data.middle, data.lower].forEach((values, i) => bands[i].setData(values));
  rsi.setData(data.rsi);
  el("chart-price").textContent = rows.length
    ? rows.at(-1).close.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "—";
  if (fit) chart.timeScale().fitContent();
  resize();
  renderBot();
}
function status() {
  el("chart-feed").textContent = !lastUpdate
    ? "Connecting to Bitget…"
    : Date.now() - lastUpdate > 45000
      ? "Feed delayed · Prices may be stale"
      : `${streaming ? "Live stream" : "Refreshing every 15s"} · ${new Date(lastUpdate).toLocaleTimeString()}`;
}
async function history(version, fit = false) {
  const revision = streamRevision;
  request?.abort();
  const controller = new AbortController();
  request = controller;
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const params = new URLSearchParams({ symbol, productType: "USDT-FUTURES", granularity: interval, limit: "200" });
    const response = await fetch("https://api.bitget.com/api/v2/mix/market/candles?" + params, {
      signal: controller.signal,
      credentials: "omit",
    });
    if (!response.ok) throw Error();
    const data = await response.json();
    if (data.code !== "00000") throw Error();
    const next = normalizeCandles(data.data);
    if (!next.length) throw Error();
    if (version !== generation) return;
    const merged = new Map(
      (streamRevision === revision ? [...rows, ...next] : [...next, ...rows]).map((c) => [c.time, c]),
    );
    rows = [...merged.values()].sort((a, b) => a.time - b.time).slice(-300);
    lastUpdate = Date.now();
    draw(fit);
    status();
  } catch (error) {
    if (version === generation && error.name !== "AbortError")
      el("chart-feed").textContent = "Bitget feed unavailable · Retrying";
    else if (version === generation) el("chart-feed").textContent = "Feed timed out · Retrying";
  } finally {
    clearTimeout(timeout);
  }
}
function connect(version) {
  if (version !== generation) return;
  try {
    socket = new WebSocket("wss://ws.bitget.com/v2/ws/public");
    const ws = socket;
    ws.onopen = () => {
      if (version !== generation) return ws.close();
      ws.send(
        JSON.stringify({
          op: "subscribe",
          args: [{ instType: "USDT-FUTURES", channel: "candle" + interval, instId: symbol }],
        }),
      );
      ping = setInterval(() => {
        if (ws.readyState === 1) ws.send("ping");
      }, 25000);
    };
    ws.onmessage = (event) => {
      if (version !== generation || event.data === "pong") return;
      try {
        const data = JSON.parse(event.data);
        if (data.event === "error") {
          ws.close();
          return;
        }
        if (data.arg?.instId !== symbol || !data.data) return;
        const next = normalizeCandles(data.data);
        if (!next.length || !rows.length) return;
        const merged = new Map(rows.map((c) => [c.time, c]));
        for (const c of next) merged.set(c.time, c);
        rows = [...merged.values()].sort((a, b) => a.time - b.time).slice(-300);
        lastUpdate = Date.now();
        streamRevision++;
        streaming = true;
        draw();
        status();
      } catch {
        /* Ignore malformed feed messages. */
      }
    };
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      if (version !== generation) return;
      clearInterval(ping);
      streaming = false;
      status();
      reconnect = setTimeout(async () => {
        await history(version);
        if (version === generation) connect(version);
      }, 5000);
    };
  } catch {
    streaming = false;
  }
}
async function load() {
  const version = ++generation;
  request?.abort();
  clearInterval(ping);
  clearInterval(poll);
  clearTimeout(reconnect);
  socket?.close();
  rows = [];
  lastUpdate = 0;
  streaming = false;
  draw();
  status();
  await history(version, true);
  if (version !== generation) return;
  connect(version);
  poll = setInterval(() => {
    if (!streaming || Date.now() - lastUpdate > 30000) void history(version);
    status();
  }, 15000);
}
for (const button of document.querySelectorAll("[data-symbol]"))
  button.addEventListener("click", () => {
    symbol = button.dataset.symbol;
    for (const b of document.querySelectorAll("[data-symbol]")) b.setAttribute("aria-pressed", String(b === button));
    void load();
  });
document.addEventListener('terminal-market-select', event => {
  const selected = event.detail?.symbol;
  if (typeof selected !== 'string' || !/^[A-Z0-9]{1,24}USDT$/.test(selected) || selected === symbol) return;
  symbol = selected; void load();
});
el("chart-interval").addEventListener("change", (event) => {
  interval = event.target.value;
  void load();
});
el("chart-fit").addEventListener("click", () => chart.timeScale().fitContent());
window.addEventListener("pagehide", () => {
  generation++;
  request?.abort();
  socket?.close();
  clearInterval(ping);
  clearInterval(poll);
  clearTimeout(reconnect);
});
// Bot overlays consume the authenticated trading controller, never a separate credential.
let tradingState = null,
  tradingReceived = 0,
  overlayDetails = {},
  priceLines = [];
const botMarkers = createSeriesMarkers(candles, []);
const actionButton = document.createElement("button");
actionButton.type = "button";
actionButton.className = "secondary";
actionButton.id = "chart-bot-actions";
actionButton.textContent = "Bot actions · Sign in";
document.querySelector(".chart-tools").prepend(actionButton);
const eventDialog = document.createElement("dialog");
eventDialog.id = "bot-events-dialog";
eventDialog.setAttribute("aria-label", "Bot action details");
const eventTitle = document.createElement("h2");
eventTitle.textContent = "Bot actions";
const eventBody = document.createElement("div");
const closeEvents = document.createElement("button");
closeEvents.textContent = "Close";
closeEvents.className = "secondary";
closeEvents.addEventListener("click", () => eventDialog.close());
eventDialog.append(eventTitle, eventBody, closeEvents);
document.body.append(eventDialog);
function showBotDetails(entries) {
  eventBody.replaceChildren();
  for (const entry of entries) {
    const item = document.createElement("p");
    item.textContent = [
      entry.event ?? entry.status,
      entry.environment?.toUpperCase(),
      entry.symbol,
      entry.side,
      entry.observedAt ? "Observed " + new Date(entry.observedAt).toLocaleString() : "Historical timing not recorded",
      entry.filled ? "Filled " + entry.filled : "",
      entry.fillPrice ? "Average fill " + entry.fillPrice : "",
      entry.limit ? "Order limit " + entry.limit : "",
      entry.stop ? "SL " + entry.stop : "",
      entry.target ? "TP " + entry.target : "",
      entry.message ?? "",
      entry.status === "closed" ? "Exit price and realised P&L not available in this journal." : "",
      entry.source === "demo-test" ? "Demo test trade" : "Strategy trade",
    ]
      .filter(Boolean)
      .join(" · ");
    eventBody.append(item);
  }
  if (!entries.length)
    eventBody.textContent =
      "No recorded actions for this market and account. Markers appear when the bot proposes or executes a trade.";
  if (!eventDialog.open) eventDialog.showModal();
}
function renderBot() {
  const effective = tradingState
    ? { ...tradingState, stale: tradingState.stale || Date.now() - tradingReceived > 35000 }
    : null;
  const result = botOverlays(
    effective,
    symbol,
    rows,
    Date.now(),
    { "5m": 300, "15m": 900, "1H": 3600, "4H": 14400, "1D": 86400 }[interval],
  );
  overlayDetails = result.details;
  botMarkers.setMarkers(result.markers);
  for (const line of priceLines) candles.removePriceLine(line);
  priceLines = result.lines.map((line) => candles.createPriceLine(line));
  actionButton.textContent = effective
    ? "Bot actions · " + effective.settings.environment.toUpperCase() + (effective.stale ? " · stale" : "")
    : "Bot actions · Sign in";
}
document.addEventListener("terminal-trading", (event) => {
  tradingState = event.detail;
  tradingReceived = Date.now();
  eventBody.replaceChildren();
  if (!tradingState) eventDialog.close();
  renderBot();
});
actionButton.addEventListener("click", () =>
  showBotDetails(
    tradingState
      ? [...(tradingState.journal.proposals ?? []), ...(tradingState.journal.entries ?? [])]
          .filter((e) => e.symbol === symbol && e.environment === tradingState.settings.environment)
          .slice(-30)
      : [],
  ),
);
chart.subscribeClick((param) => {
  const detail = overlayDetails[param.hoveredObjectId];
  if (detail) showBotDetails([detail]);
});
setInterval(renderBot, 5000);
void load();
