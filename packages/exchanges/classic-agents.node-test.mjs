import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgents, executorAgent, scanAgent } from "./classic-agents.mjs";
const hour = 3_600_000;
const now = 100 * hour + 500;
const market = { symbol: "BTC/USDT:USDT", status: "connected", candleTime: 99 * hour,
  price: 100, close: 100, lower: 101, upper: 120, previousClose: 105, previousLower: 102,
  previousUpper: 120, rsi: 25, rules: { amountStep: 0.001, contractSize: 1, minAmount: 0.001, minCost: 5 } };
const fixture = () => ({ accountStatus: "connected", account: { equity: 1000, available: 1000, positions: [] }, markets: [structuredClone(market)] });

test("real signal passes risk, sizes within combined budget and produces a non-submitted proposal", () => {
  const state = fixture();
  state.markets.push({ ...structuredClone(market), symbol: "SOL/USDT:USDT" });
  const result = runAgents(state, { permission: "read-write" }, now);
  const first = result.decisions[0];
  assert.equal(first.scan.side, "long");
  assert.equal(first.risk.status, "passed");
  assert.equal(first.size.quantity, 9.9);
  assert.equal(first.size.stop, 98);
  assert.equal(first.size.target, 104);
  assert.equal(first.execution.status, "review");
  assert.equal(first.execution.submitted, false);
  assert.match(first.execution.reason, /not connected/);
  assert.ok(result.decisions.reduce((sum, d) => sum + (d.size.riskAmount ?? 0), 0) <= 20);
  assert.ok(result.decisions.reduce((sum, d) => sum + (d.size.notional ?? 0), 0) <= 1000);
  assert.equal(runAgents(state, {}, now).decisions[0].execution.id, first.execution.id);
});

test("short proposals reverse stop and target; a band position alone does not repeat a crossing", () => {
  const state = fixture();
  Object.assign(state.markets[0], { rsi: 80, upper: 99, lower: 80, previousClose: 95, previousUpper: 98 });
  const proposal = runAgents(state, {}, now).decisions[0];
  assert.equal(proposal.scan.side, "short");
  assert.equal(proposal.size.stop, 102);
  assert.equal(proposal.size.target, 96);
  state.markets[0].previousClose = 100;
  assert.equal(scanAgent(state.markets[0], now).status, "waiting");
});

test("pause, missing account, exposure, stale data, price drift and exchange limits block proposals", () => {
  for (const mutate of [
    (s) => { s.account = null; },
    (s) => { s.accountStatus = "unavailable"; },
    (s) => { s.account.equity = -1; },
    (s) => { s.account.positions = [{ symbol: "SOLUSDT" }]; },
    (s) => { s.markets[0].candleTime -= hour; },
    (s) => { s.markets[0].price = 102; },
    (s) => { s.markets[0].rules.minCost = 10000; },
    (s) => { s.markets[0].rules.amountStep = null; },
  ]) {
    const state = fixture(); mutate(state);
    const result = runAgents(state, {}, now).decisions[0];
    assert.equal(result.execution.status, "blocked");
    assert.equal(result.execution.submitted, false);
  }
  const paused = runAgents(fixture(), { paused: true }, now).decisions[0];
  assert.equal(paused.risk.reason, "Agents paused by operator");
  assert.equal(paused.execution.submitted, false);
});

test("executor rejects stale or malformed proposals and never accepts an order transport", () => {
  const plan = runAgents(fixture(), {}, now).decisions[0].size;
  assert.equal(executorAgent({ ...plan, stop: 200 }, market, now, "read-write", false).status, "blocked");
  assert.equal(executorAgent(plan, market, now + hour, "read-write", false).status, "blocked");
  assert.equal(executorAgent({ ...plan, quantity: NaN }, market, now, "read-write", false).submitted, false);
});
