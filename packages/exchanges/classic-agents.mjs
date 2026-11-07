const HOUR = 3_600_000;
const positive = (value) => Number.isFinite(value) && value > 0;
export const strategy = Object.freeze({ risk: 0.02, stop: 0.02, target: 0.04 });

export function scanAgent(market, now) {
  if (market.status !== "connected" || market.candleTime !== Math.floor(now / HOUR) * HOUR - HOUR ||
      ![market.close, market.price, market.lower, market.upper, market.previousClose,
        market.previousLower, market.previousUpper].every(positive) ||
      !Number.isFinite(market.rsi) || market.rsi < 0 || market.rsi > 100) {
    return { status: "blocked", reason: "Fresh, complete hourly market data is required" };
  }
  const side = market.previousClose >= market.previousLower && market.close < market.lower && market.rsi < 30 ? "long"
    : market.previousClose <= market.previousUpper && market.close > market.upper && market.rsi > 70 ? "short" : null;
  return { status: side ? "signal" : "waiting", side,
    reason: side ? `${side === "long" ? "Lower" : "Upper"} band crossed · RSI ${market.rsi.toFixed(1)}`
      : "Waiting for a Bollinger band crossing and RSI below 30 or above 70" };
}

export function riskAgent(scan, market, account, accountStatus, paused) {
  if (paused) return { status: "blocked", reason: "Agents paused by operator" };
  if (scan.status !== "signal") return { status: scan.status, reason: scan.reason };
  if (accountStatus !== "connected" || !positive(account?.equity) || !positive(account?.available)) {
    return { status: "blocked", reason: "A connected account with positive equity and available balance is required" };
  }
  if (!Array.isArray(account.positions) || account.positions.length) {
    return { status: "blocked", reason: "Existing positions need risk review before new exposure" };
  }
  if (Math.abs(market.price / market.close - 1) > 0.01) {
    return { status: "blocked", reason: "Price moved more than 1% from the signal close" };
  }
  return { status: "passed", reason: "Account, exposure and price checks passed", riskBudget: account.equity * strategy.risk };
}

export function sizerAgent(scan, risk, market, available, remainingRisk) {
  if (risk.status !== "passed") return { status: "blocked", reason: risk.reason };
  const { amountStep, contractSize, minAmount, minCost } = market.rules ?? {};
  if (![amountStep, contractSize].every(positive) || ![minAmount, minCost].every((value) => Number.isFinite(value) && value >= 0)) {
    return { status: "blocked", reason: "Exchange quantity rules are unavailable" };
  }
  const budget = Math.min(risk.riskBudget, remainingRisk);
  const entry = market.price;
  const notionalCap = Math.min(budget / strategy.stop, available * 0.99);
  const contracts = Number((Math.floor(notionalCap / entry / contractSize / amountStep) * amountStep).toPrecision(12));
  const quantity = contracts * contractSize;
  const notional = quantity * entry;
  if (!positive(contracts) || contracts < minAmount || notional < minCost || notional > notionalCap + 1e-8) {
    return { status: "blocked", reason: "Remaining budget is below the exchange minimum order size" };
  }
  const long = scan.side === "long";
  return { status: "sized", reason: "2% maximum combined proposal risk · 1% cash reserve · no leverage assumed",
    symbol: market.symbol, side: scan.side, contracts, quantity, entry, notional,
    stop: entry * (long ? 1 - strategy.stop : 1 + strategy.stop),
    target: entry * (long ? 1 + strategy.target : 1 - strategy.target), riskAmount: notional * strategy.stop };
}

// This executor performs preflight only. It has no exchange client or order submission capability.
export function executorAgent(plan, market, now, permission, paused) {
  if (paused) return { status: "blocked", reason: "Agents paused by operator", submitted: false };
  if (plan.status !== "sized") return { status: "blocked", reason: plan.reason, submitted: false };
  const long = plan.side === "long";
  const valid = [plan.entry, plan.stop, plan.target, plan.quantity, plan.contracts, plan.riskAmount].every(positive) &&
    (long ? plan.stop < plan.entry && plan.target > plan.entry : plan.stop > plan.entry && plan.target < plan.entry) &&
    market.candleTime === Math.floor(now / HOUR) * HOUR - HOUR;
  if (!valid) return { status: "blocked", reason: "Order proposal failed price, quantity or freshness validation", submitted: false };
  return { status: "review", id: `${market.symbol}:${market.candleTime}:${plan.side}`,
    reason: permission === "read-write" ? "Preflight passed · Live submission is not connected"
      : "Preflight passed · Read-only key selected", submitted: false };
}

export function runAgents(state, { permission = "read-only", paused = false } = {}, now = Date.now()) {
  let available = Math.max(0, state.account?.available ?? 0);
  let remainingRisk = Math.max(0, (state.account?.equity ?? 0) * strategy.risk);
  const decisions = state.markets.map((market) => {
    const scan = scanAgent(market, now);
    const risk = market.trade === false ? { status: 'blocked', reason: 'Watch only · enable Trade in Markets to evaluate entries' }
      : riskAgent(scan, market, state.account, state.accountStatus, paused);
    const size = sizerAgent(scan, risk, market, available, remainingRisk);
    const execution = executorAgent(size, market, now, permission, paused);
    if (size.status === "sized") { available -= size.notional; remainingRisk -= size.riskAmount; }
    return { symbol: market.symbol, scan, risk, size, execution };
  });
  return { updatedAt: now, paused, mode: "preflight-only", decisions };
}
