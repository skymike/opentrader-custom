const { createServer } = require("node:http");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const {
  chromium,
} = require("C:/Users/Michael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const root = path.resolve("app/frontend/terminal");
(async () => {
  const server = createServer(async (req, res) => {
    try {
      const file = path.resolve(root, "." + new URL(req.url, "http://localhost").pathname);
      if (!file.startsWith(root + path.sep)) throw Error();
      res.setHeader(
        "Content-Type",
        file.endsWith(".css") ? "text/css" : file.endsWith(".html") ? "text/html" : "text/javascript",
      );
      res.end(await readFile(file));
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let signedIn = false;
    const settings = {
      environment: "demo",
      mode: "approval",
      armed: false,
      maxNotional: 100,
      riskPct: 2,
      dailyLossPct: 3,
    };
    const connections = {
      demo: { configured: false, apiVersion: "v2" },
      live: { configured: false, apiVersion: "v2" },
    };
    const journal = {
      message: "Ready. New entries are stopped.",
      accounts: { demo: { equity: 10250, available: 9850, updatedAt: Date.now() } },
      proposals: [],
      entries: [],
      halted: {},
    };
    await page.route("**/api/terminal/**", async (r) => {
      const u = new URL(r.request().url());
      if (!signedIn && r.request().headers().authorization !== "fixture-password")
        return r.fulfill({ status: 401, json: { message: "Sign in" } });
      signedIn = true;
      if (u.pathname.endsWith("/state"))
        return r.fulfill({
          json: {
            updatedAt: Date.now(),
            markets: [],
            account: null,
            accountStatus: "not-connected",
            logs: [],
            control: { paused: false },
          },
        });
      if (u.pathname.endsWith("/assistant")) return r.fulfill({ json: { enabled: false, status: "disabled" } });
      if (u.pathname.endsWith("/connections")) return r.fulfill({ json: { connections: [] } });
      if (u.pathname.endsWith("/trading")) {
        if (r.request().method() === "PUT") Object.assign(settings, r.request().postDataJSON());
        return r.fulfill({ json: { settings, connections, journal, stale: false } });
      }
      return r.fulfill({ json: {} });
    });
    const now = Math.floor(Date.now() / 3600000) * 3600000;
    if (!process.env.LIVE_CHART)
      await page.route("https://api.bitget.com/**", (r) =>
        r.fulfill({
          json: {
            code: "00000",
            data: Array.from({ length: 200 }, (_, i) => {
              const price = 65000 + i * 8 + Math.sin(i / 5) * 300;
              return [now - (199 - i) * 3600000, price, price + 100, price - 120, price + 30, 100 + i];
            }),
          },
        }),
      );
    if (!process.env.LIVE_CHART)
      await page.routeWebSocket("wss://ws.bitget.com/**", (ws) => {
        ws.onMessage(() => {});
      });
    await page.goto("http://127.0.0.1:" + server.address().port + "/index.html");
    await page.waitForFunction(() => document.querySelector("#chart-price").textContent !== "—");
    await page.locator("#password").fill("fixture-password");
    await page.locator("#connect-button").click();
    await page.waitForFunction(() => !document.getElementById("trading-fields").disabled);
    await page.getByRole("button", { name: "Risk & execution settings", exact: true }).click();
    await page.locator("#trade-riskPct").fill("1");
    await page.locator("#execution-settings-dialog button[form=trading-form]").click();
    await page.waitForFunction(() => document.getElementById("trade-risk-summary").textContent.startsWith("1%"));
    await page.locator("#close-execution-settings").click();
    await page.screenshot({ path: path.resolve("../terminal-redesign-desktop.png"), fullPage: true });
    for (const size of [
      { width: 1440, height: 900 },
      { width: 1366, height: 768 },
      { width: 1920, height: 1080 },
    ]) {
      await page.setViewportSize(size);
      await page.waitForTimeout(150);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight),
        true,
        JSON.stringify(size) + " vertical overflow",
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        "horizontal overflow",
      );
      for (const id of ["trading-panel", "trade-proposals-empty", "trade-orders-empty", "price-chart"]) {
        assert.equal(await page.locator("#" + id).isVisible(), true, id + " visible");
      }
    }
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.evaluate(() => {
      document.querySelector("#trade-proposals-empty").hidden = true;
      document.querySelector("#trade-proposals").innerHTML =
        "<section><h3>DEMO · BUY BTC/USDT</h3><p>0.001 units · Limit 75000 · Stop 73500 · Target 78000 · Estimated risk 1.50 USDT</p><small>Approval expires in 60 seconds. IOC order.</small><button>Approve trade</button><button>Reject</button></section>";
    });
    assert.equal(
      await page.evaluate(() => {
        const agent = document.querySelector(".compact-agents").getBoundingClientRect(),
          sidebar = document.querySelector(".terminal-sidebar").getBoundingClientRect();
        return agent.bottom <= sidebar.bottom + 1;
      }),
      true,
      "populated agents fit",
    );
    journal.entries.push({
      id: "fixture-entry",
      environment: "demo",
      symbol: "BTCUSDT",
      side: "long",
      status: "open",
      filled: 0.001,
      quantity: 0.001,
      fillPrice: 66500,
      fillObservedAt: now - 3600000,
      limit: 66600,
      stop: 65000,
      target: 69000,
      protected: true,
    });
    await page.locator("#trade-mode").selectOption("automatic");
    await page.locator("#trading-form button[type=submit]").click();
    await page.locator("#chart-bot-actions").click();
    await page.waitForFunction(() =>
      document.getElementById("bot-events-dialog").textContent.includes("Average fill 66500"),
    );
    await page.locator("#bot-events-dialog button").click();
    await page.getByRole("button", { name: "Bot strategy", exact: true }).click();
    await page.getByRole("button", { name: "Market analysis", exact: true }).click();
    await page.locator("#ai-analyse").click();
    await page.waitForFunction(() => document.getElementById("ai-status").textContent.includes("Analysis requested"));
    await page.getByRole("tab", { name: "Monitoring", exact: true }).click();
    assert.equal(await page.locator("#equity").isVisible(), true);
    await page.getByRole("tab", { name: "Managed positions", exact: true }).click();
    await page.locator("#theme-toggle").click();
    await page.locator('[data-symbol="SOLUSDT"]').click();
    await page.locator("#chart-interval").selectOption("15m");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      "mobile overflow",
    );
    await page.screenshot({ path: path.resolve("../terminal-redesign-mobile.png"), fullPage: true });
    await page.locator("#disconnect").click();
    assert.equal(await page.locator("#trade-mode").isDisabled(), true);
    assert.deepEqual(errors, []);
    console.log(
      "PASS: chart, symbols, timeframes, theme, tabs, desktop viewport fit and mobile width; no browser errors",
    );
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
