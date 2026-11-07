// Rearrange existing controls without replacing their IDs or execution handlers.
const el = (id) => document.getElementById(id);
const main = document.querySelector("main");
const create = (tag, cls, html = "") => {
  const node = document.createElement(tag);
  node.className = cls;
  node.innerHTML = html;
  return node;
};
document.documentElement.dataset.theme ||= "dark";
const oldWorkspace = document.querySelector(".workspace");
const layout = create("div", "terminal-grid");
const market = create(
  "article",
  "market-terminal",
  `<div class="chart-toolbar"><div class="symbol-tabs" role="group" aria-label="Chart market"><button data-symbol="BTCUSDT" aria-pressed="true">BTC / USDT</button><button data-symbol="SOLUSDT" aria-pressed="false">SOL / USDT</button></div><div class="chart-tools"><select id="chart-interval" aria-label="Chart timeframe"><option value="5m">5 minutes</option><option value="15m">15 minutes</option><option value="1H" selected>1 hour</option><option value="4H">4 hours</option><option value="1D">1 day</option></select><button id="chart-fit" class="secondary">Fit chart</button><a href="https://aggr.trade" target="_blank" rel="noopener noreferrer">Order flow ↗</a></div></div><div class="chart-quote"><strong id="chart-price">—</strong><span id="chart-feed" role="status">Loading public Bitget feed…</span><span>USDT perpetual · BB 20/2 · RSI 14</span></div><div id="price-chart" aria-label="Interactive candlestick, volume and RSI chart"></div><div class="chart-caption"><a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">Charting by TradingView</a><span>Chart timeframe only · Trading strategy stays 1h</span></div>`,
);
const sidebar = create("aside", "terminal-sidebar");
const trading = el("trading-panel");
const approvals = el("trade-proposals").parentElement;
const managed = el("trade-orders").parentElement;
const activity = document.querySelector(".execution-activity");
const agentPanel = create("article", "compact-agents");
agentPanel.append(create("div", "section-title", "<h2>Agent status</h2>"));
agentPanel.firstChild.append(el("pause-agents"));
agentPanel.append(el("agents"));
agentPanel.title = "Monitoring agent status; execution status is shown separately above.";
const bottom = create("article", "terminal-bottom");
const tabs = create("div", "terminal-tabs");
const pages = create("div", "terminal-tab-pages");
function tab(label, node, id) {
  const button = create("button", "secondary", label);
  button.type = "button";
  button.setAttribute("role", "tab");
  button.id = "tab-" + id;
  button.setAttribute("aria-controls", id);
  const page = create("section", "terminal-tab-page");
  page.id = id;
  page.setAttribute("role", "tabpanel");
  page.setAttribute("aria-labelledby", button.id);
  page.append(node);
  button.addEventListener("click", () => {
    for (const b of tabs.children) {
      b.setAttribute("aria-selected", String(b === button));
      b.tabIndex = b === button ? 0 : -1;
    }
    for (const p of pages.children) p.hidden = p !== page;
  });
  tabs.append(button);
  pages.append(page);
  page.hidden = pages.children.length !== 1;
  button.setAttribute("aria-selected", String(!page.hidden));
  button.tabIndex = page.hidden ? -1 : 0;
}
tabs.setAttribute("role", "tablist");
tabs.setAttribute("aria-label", "Account activity");
tabs.addEventListener("keydown", (event) => {
  const buttons = [...tabs.children];
  let index = buttons.indexOf(document.activeElement);
  if (index < 0) return;
  if (event.key === "ArrowRight") index = (index + 1) % buttons.length;
  else if (event.key === "ArrowLeft") index = (index + buttons.length - 1) % buttons.length;
  else return;
  event.preventDefault();
  buttons[index].click();
  buttons[index].focus();
});
tab("Managed positions", managed, "panel-managed");
const monitoring = create("div", "monitoring-panel", "<h2>Separate read-only monitoring account</h2>");
monitoring.append(
  document.querySelector(".metrics"),
  el("positions").closest("article"),
  el("curve").closest("article"),
);
tab("Monitoring", monitoring, "panel-monitoring");
const history = el("trade-history").closest("details");
history.open = true;
tab("History", history, "panel-history");
const decisions = el("agent-decisions").closest("article");
decisions.append(el("markets"), document.querySelector(".flow"));
tab("Decisions", decisions, "panel-decisions");
tab("Activity", el("logs").closest("article"), "panel-activity");
bottom.append(tabs, pages);
const ai = el("ai-commentary");
ai.classList.add("terminal-ai");
el("ai-heading").textContent = "AI market analyst";
const analysisButton = create("button", "secondary", "Analyse now");
analysisButton.id = "ai-analyse";
analysisButton.type = "button";
analysisButton.disabled = true;
const analysisTabs = create("div", "analysis-tabs");
const marketTab = create("button", "secondary", "Market analysis");
marketTab.type = "button";
marketTab.setAttribute("aria-pressed", "true");
const strategyTab = create("button", "secondary", "Bot strategy");
strategyTab.type = "button";
strategyTab.setAttribute("aria-pressed", "false");
analysisTabs.append(marketTab, strategyTab, analysisButton);
const strategyBody = create("div", "strategy-analysis");
strategyBody.id = "ai-strategy";
strategyBody.hidden = true;
strategyBody.append(el("ai-summary"), el("ai-explanations"), el("ai-facts"));
const marketBody = create("div", "market-analysis");
marketBody.id = "ai-market-analysis";
ai.insertBefore(analysisTabs, ai.querySelector(".ai-footer"));
ai.insertBefore(marketBody, ai.querySelector(".ai-footer"));
ai.insertBefore(strategyBody, ai.querySelector(".ai-footer"));
marketTab.addEventListener("click", () => {
  marketBody.hidden = false;
  strategyBody.hidden = true;
  marketTab.setAttribute("aria-pressed", "true");
  strategyTab.setAttribute("aria-pressed", "false");
});
strategyTab.addEventListener("click", () => {
  marketBody.hidden = true;
  strategyBody.hidden = false;
  marketTab.setAttribute("aria-pressed", "false");
  strategyTab.setAttribute("aria-pressed", "true");
});
// Detailed settings stay reachable from both execution controls and key management.
const dialog = create(
  "dialog",
  "execution-dialog",
  `<div class="dialog-heading"><h2>Execution settings</h2><button id="close-execution-settings" class="secondary" type="button">Close</button></div>`,
);
dialog.id = "execution-settings-dialog";
dialog.setAttribute("aria-label", "Execution settings");
const risk = el("trade-risk-settings");
risk.open = true;
for (const input of risk.querySelectorAll("input")) input.setAttribute("form", "trading-form");
const settingsFields = create("fieldset", "execution-settings-fields");
settingsFields.append(risk, el("execution-connections"), el("demo-test-tools"));
settingsFields.append(
  create("div", "settings-actions", '<button type="submit" form="trading-form">Save &amp; stop entries</button>'),
);
dialog.append(settingsFields);
document.body.append(dialog);
const syncDisabled = () => {
  settingsFields.disabled = el("trading-fields").disabled;
};
syncDisabled();
new MutationObserver(syncDisabled).observe(el("trading-fields"), { attributes: true, attributeFilter: ["disabled"] });
const settingsButton = create("button", "secondary execution-settings-button", "Risk &amp; execution settings");
settingsButton.type = "button";
settingsButton.addEventListener("click", () => dialog.showModal());
el("trading-fields").append(settingsButton);
el("close-execution-settings").addEventListener("click", () => dialog.close());
activity.remove();
const approvalPanel = create("article", "approval-panel");
approvalPanel.append(approvals);
sidebar.append(trading, approvalPanel, agentPanel);
layout.append(market, sidebar, bottom, ai);
const connection = document.querySelector(".connection");
const statusstrip = create("div", "workspace-status");
statusstrip.append(connection, el("open-key-health"));
const footer = document.querySelector("footer");
footer.prepend(el("freshness"));
main.replaceChildren(statusstrip, layout, footer);
oldWorkspace.remove();
document.querySelector(".settings-menu a").addEventListener("click", (event) => {
  event.preventDefault();
  ai.scrollIntoView({ block: "nearest" });
  el("ai-toggle").focus();
});
