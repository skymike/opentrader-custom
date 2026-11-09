import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createTradingClient } from './terminal-exchange-router.mjs';
import { tradingPath, atomicJson, readJson, withTradingLock, activeEntry } from './terminal-trading-store.mjs';
import { ensureLeverage } from './terminal-execution.mjs';
import { toSymbolId } from './terminal-markets.mjs';
const fail = (message, status = 400) => { const error = new Error(message); error.status = status; throw error; };
const positive = n => Number.isFinite(n) && n > 0;
const aligned = (n, step) => positive(step) && Math.abs(n / step - Math.round(n / step)) < 1e-7;
export function manualPreview(body, context, state, now = Date.now()) {
  const symbol = toSymbolId(body.symbol);
  const connection = state.connections[body.environment];
  if (!['demo', 'live'].includes(body.environment) || !connection?.credentials || body.connectionRevision !== connection.revision) fail('Connection changed; refresh', 409);
  if (!symbol || !['open', 'close'].includes(body.action) || !['long', 'short'].includes(body.side) || !['limit', 'market'].includes(body.orderType)) fail('Invalid order selection');
  if (!Number.isInteger(body.leverage) || body.leverage < 1 || body.leverage > 20) fail('Leverage must be 1 to 20');
  if (!positive(context.price) || !Number.isFinite(context.quoteTime) || now - context.quoteTime > 15000 || context.quoteTime > now + 5000) fail('Fresh exchange quote required');
  if (context.account?.posMode !== 'one_way_mode' || context.account?.marginMode !== 'isolated') fail('Set this market to one-way isolated mode on Bitget');
  const r = context.rules, quantity = body.quantity, limit = body.orderType === 'limit' ? body.limit : context.price;
  if (!r || r.status !== 'normal' || ![r.step, r.tick, r.minSize, r.minCost, r.maxSize].every(positive) || !positive(quantity) || !positive(limit) || !aligned(quantity, r.step) || quantity < r.minSize || quantity > r.maxSize || quantity * limit < r.minCost || (body.orderType === 'limit' && !aligned(limit, r.tick))) fail('Quantity or price does not meet exchange increments and minimums');
  const active = state.journal.entries.filter(e => e.environment === body.environment && e.symbol === symbol && activeEntry(e));
  if (body.action === 'open') {
    if (state.journal.halted[body.environment]) fail('Trading halted: ' + state.journal.halted[body.environment], 409);
    if (active.length || context.positions.some(p => p.symbol === symbol && Number(p.total) > 0) || context.orders.some(o => o.symbol === symbol)) fail('Existing orders or position on this pair must be resolved first', 409);
    const managed = state.journal.entries.filter(e => e.environment === body.environment && activeEntry(e));
    const matchesPosition = (entry, row) => row.symbol === entry.symbol && row.holdSide === entry.side && row.posMode === 'one_way_mode' && Number(row.total) === (entry.positionQuantity ?? entry.filled);
    const matchesProtection = (entry, order) => order.symbol === entry.symbol && order.orderId && entry.protectionOrderIds?.includes(String(order.orderId));
    if (managed.some(e => e.status !== 'open' || e.protected !== true || !Number.isFinite(e.protectionVerifiedAt) || now - e.protectionVerifiedAt > 30000 || e.protectionVerifiedAt > now + 5000 || !positive(e.riskAmount)) ||
        context.positions.length !== managed.length || !managed.every(e => context.positions.some(p => matchesPosition(e, p))) ||
        context.orders.some(o => !managed.some(e => matchesProtection(e, o))) ||
        !managed.every(e => e.protectionOrderIds?.length && e.protectionOrderIds.every(id => context.orders.some(o => o.symbol === e.symbol && String(o.orderId) === id)))) fail('Unmanaged or unverified account exposure blocks new positions', 409);
    if (!positive(context.equity) || !positive(context.available)) fail('Positive equity and available margin required');
    const day = state.journal.days[body.environment];
    if (day?.date === new Date(now).toISOString().slice(0, 10) && context.equity <= day.equity * (1 - state.settings.dailyLossPct / 100)) fail('Daily equity-loss limit reached');
    if (quantity * limit > state.settings.maxNotional || quantity * limit / body.leverage > context.available * 0.99) fail('Order exceeds notional limit or available margin');
    for (const n of [body.stopLossPct, body.takeProfitPct]) if (!Number.isFinite(n) || n < 0.1 || n > 50) fail('TP and SL must be 0.1 to 50 percent');
  } else {
    if (active.some(e => e.action === 'close' || e.closeId || !['open'].includes(e.status))) fail('Resolve the existing working order before closing this pair', 409);
    const position = context.positions.find(p => p.symbol === symbol && p.holdSide === body.side);
    if (!position || quantity > Number(position.total)) fail('Close quantity exceeds the selected position');
    // Existing protective orders remain in force while a reduce-only close is working.
    if (context.orders.some(o => o.symbol === symbol && !['loss_plan', 'profit_plan', 'pos_loss', 'pos_profit'].includes(o.planType) && o.type !== 'tpsl')) fail('Resolve pending exchange orders before closing', 409);
  }
  const long = body.side === 'long', round = n => Number((Math.round(n / r.tick) * r.tick).toPrecision(12));
  const stop = body.action === 'open' ? round(limit * (1 + (long ? -1 : 1) * body.stopLossPct / 100)) : undefined;
  const target = body.action === 'open' ? round(limit * (1 + (long ? 1 : -1) * body.takeProfitPct / 100)) : undefined;
  if (body.action === 'open' && !(long ? stop < limit && limit < target : target < limit && limit < stop)) fail('TP/SL round to invalid prices');
  if (body.action === 'open') {
    const reserved = state.journal.entries.filter(e => e.environment === body.environment && activeEntry(e) && e.action !== 'close').reduce((sum, e) => sum + (e.riskAmount ?? Infinity), 0);
    if (reserved + quantity * (Math.abs(limit - stop) + limit * 0.002) > context.equity * state.settings.riskPct / 100) fail('Combined stop-risk budget exceeded');
  }
  return { environment: body.environment, action: body.action, side: body.side, orderType: body.orderType, leverage: body.leverage,
    stopLossPct: body.stopLossPct, takeProfitPct: body.takeProfitPct, id: 'm' + randomUUID().replaceAll('-', '').slice(0, 30), source: 'manual', symbol, marketSymbol: body.symbol, connectionRevision: connection.revision,
    apiVersion: connection.apiVersion ?? 'v2', quantity, limit, stop, target, tick: r.tick, timeInForce: 'gtc', referencePrice: context.price,
    riskAmount: body.action === 'open' ? quantity * (Math.abs(limit - stop) + limit * 0.002) : 0,
    createdAt: now, expiresAt: now + 60000, marginMode: 'isolated', positionMode: 'one_way_mode' };
}
export function registerManualTrading(app, authorize, load, clientFor = createTradingClient) {
  const base = '/api/terminal/trading/manual';
  const guarded = fn => async (request, reply) => {
    try { return await withTradingLock(tradingPath(), () => fn(request)); }
    catch (error) { return reply.code(error.status ?? 503).send({ message: error.status ? error.message : 'Exchange or storage unavailable; refresh order state before retrying.' }); }
  };
  const client = (state, environment) => {
    if (!['demo', 'live'].includes(environment)) fail('Choose demo or live');
    const c = state.connections[environment]; if (!c?.credentials) fail('Save this connection first');
    return clientFor(environment, c.credentials, c.apiVersion ?? 'v2');
  };
  app.get(base + '/context', { preHandler: authorize }, guarded(async request => {
    const state = await load(), environment = request.query?.environment, symbol = toSymbolId(request.query?.symbol);
    if (!symbol) fail('Choose a futures pair');
    return { environment, connectionRevision: state.connections[environment]?.revision, ...(await client(state, environment).context(symbol)) };
  }));
  app.post(base + '/preview', { preHandler: authorize, bodyLimit: 2048 }, guarded(async request => {
    const state = await load(), body = request.body ?? {}, symbol = toSymbolId(body.symbol);
    if (!symbol) fail('Choose a futures pair');
    const context = await client(state, body.environment).context(symbol);
    const preview = manualPreview(body, context, state);
    state.journal.manualPreviews = [...(state.journal.manualPreviews ?? []).filter(p => p.expiresAt > Date.now()).slice(-19), preview];
    await atomicJson(join(state.directory, 'journal.json'), state.journal);
    return { preview };
  }));
  app.post(base + '/confirm', { preHandler: authorize, bodyLimit: 512 }, guarded(async request => {
    const state = await load(), body = request.body ?? {};
    const existing = state.journal.entries.find(e => e.id === body.previewId && e.source === 'manual');
    if (existing) return { entry: existing, duplicate: true };
    const preview = state.journal.manualPreviews?.find(p => p.id === body.previewId && p.expiresAt > Date.now());
    if (!preview) fail('Preview expired; review again', 409);
    if (preview.environment === 'live' && body.liveAcknowledgement !== 'PLACE LIVE ORDER') fail('Type PLACE LIVE ORDER to confirm');
    if (preview.action === 'open') {
      if (!Number.isFinite(state.journal.updatedAt) || Date.now() - state.journal.updatedAt > 30000 || state.journal.updatedAt > Date.now() + 5000) fail('Trading worker is stale; wait for monitoring to recover', 409);
      const control = await readJson(process.env.TERMINAL_CONTROL_PATH ?? '/credentials/control.json', { paused: false });
      if (control.paused !== false) fail('Terminal is paused; resume before opening a position', 409);
    }
    const exchange = client(state, preview.environment), context = await exchange.context(preview.symbol);
    manualPreview({ ...preview, symbol: preview.marketSymbol }, context, state);
    if (Math.abs(context.price / preview.referencePrice - 1) > 0.002) fail('Price moved; review a fresh preview', 409);
    if (preview.action === 'open') {
      const date = new Date().toISOString().slice(0, 10);
      if (state.journal.days[preview.environment]?.date !== date) state.journal.days[preview.environment] = { date, equity: context.equity };
    }
    const entry = { ...preview, status: 'preparing' };
    state.journal.entries.push(entry);
    const save = () => atomicJson(join(state.directory, 'journal.json'), state.journal);
    await save();
    try {
      const verified = entry.action === 'open' ? await ensureLeverage(exchange, entry, context) : context;
      if (Date.now() > entry.expiresAt || Date.now() - verified.quoteTime > 15000 || Math.abs(verified.price / entry.referencePrice - 1) > 0.002) throw new Error('Quote expired');
    }
    catch { entry.status = 'rejected'; entry.message = 'Leverage or fresh quote could not be verified; no order submitted'; await save(); return { entry }; }
    entry.status = 'submitting'; await save();
    try { const result = await exchange.submit(entry); entry.orderId = result.orderId; entry.status = 'submitted'; }
    catch { entry.status = 'unknown'; entry.message = 'Submission outcome uncertain; worker reconciles without resubmission'; }
    await save(); return { entry, duplicate: false };
  }));
  app.post(base + '/cancel', { preHandler: authorize, bodyLimit: 512 }, guarded(async request => {
    const state = await load(), entry = state.journal.entries.find(e => e.id === request.body?.entryId && activeEntry(e));
    if (!entry || entry.timeInForce !== 'gtc') fail('No working limit order found', 409);
    entry.cancelRequested = true;
    await atomicJson(join(state.directory, 'journal.json'), state.journal);
    return { queued: true, entry };
  }));
}
