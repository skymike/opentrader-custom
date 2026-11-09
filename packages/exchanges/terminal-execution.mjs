import { createHash } from 'node:crypto';
import { scanAgent } from './classic-agents.mjs';
import { activeEntry, validateJournal, validateSettings } from './terminal-trading-store.mjs';
import { validQuantity, validatePositions } from './terminal-bitget.mjs';
import { toSymbolId as symbolId, defaultMarkets, validateMarkets } from './terminal-markets.mjs';

const positive = (n) => Number.isFinite(n) && n > 0;
const hash = (value) => 'ot' + createHash('sha256').update(value).digest('hex').slice(0, 28);
const round = (n, step, direction = Math.floor) => Number((direction(n / step + 1e-9) * step).toPrecision(12));

export function makeProposal(market, context, settings, connection, now) {
  const signal = scanAgent({ ...market, price: context.price }, now);
  if ((settings.direction ?? 'both') !== 'both' && settings.direction !== signal.side) throw new Error('Signal direction disabled');
  if (signal.status !== 'signal') throw new Error(signal.reason);
  const { account: a, rules: r } = context;
  if (!positive(context.equity) || !positive(context.available) || !positive(context.price) ||
      !Number.isFinite(context.quoteTime) || now - context.quoteTime > 15000 || context.quoteTime > now + 5000) throw new Error('Fresh account and price required');
  if (a?.posMode !== 'one_way_mode' || a?.marginMode !== 'isolated') throw new Error('Set this market to one-way and isolated margin in Bitget');
  if (!Array.isArray(context.positions) || !Array.isArray(context.orders) || context.positions.length || context.orders.length) throw new Error('Existing exchange positions or orders block new entries');
  if (!r || r.status !== 'normal' || ![r.step, r.tick, r.minSize, r.minCost, r.maxSize].every(positive)) throw new Error('Exchange trading rules unavailable');
  if (Math.abs(context.price / market.close - 1) > 0.01) throw new Error('Price moved more than 1% from signal close');
  const long = signal.side === 'long';
  const limit = round(context.price * (long ? 1.002 : 0.998), r.tick, long ? Math.floor : Math.ceil);
  const stop = round(context.price * (long ? 1 - (settings.stopLossPct ?? 2) / 100 : 1 + (settings.stopLossPct ?? 2) / 100), r.tick, long ? Math.ceil : Math.floor);
  const target = round(context.price * (long ? 1 + (settings.takeProfitPct ?? 4) / 100 : 1 - (settings.takeProfitPct ?? 4) / 100), r.tick, long ? Math.floor : Math.ceil);
  const unitRisk = Math.abs(limit - stop) + limit * 0.002; // reserve for fees/slippage; gaps remain possible
  const quantity = round(Math.min(settings.maxNotional / limit, context.available * 0.99 * (settings.leverage ?? 1) / limit,
    context.equity * settings.riskPct / 100 / unitRisk, r.maxSize), r.step);
  if (![limit, stop, target, quantity].every(positive) || quantity < r.minSize || quantity * limit < r.minCost ||
      !(long ? stop < limit && limit < target : target < limit && limit < stop)) throw new Error('Order is below exchange minimum or prices are invalid');
  const id = hash([settings.environment, connection.revision, market.symbol, market.candleTime, signal.side, market.demoTestId ?? 'strategy'].join(':'));
  return { id, proposalId: hash(id + settings.revision), environment: settings.environment, revision: settings.revision,
    connectionRevision: connection.revision, apiVersion: connection.apiVersion ?? 'v2', symbol: symbolId(market.symbol), marketSymbol: market.symbol, side: signal.side,
    leverage: settings.leverage ?? 1, orderType: settings.orderType ?? 'limit', timeInForce: 'ioc',
    quantity, limit, stop, target, riskAmount: quantity * unitRisk, tick: r.tick, source: market.demoTestId ? 'demo-test' : 'strategy',
    createdAt: now, expiresAt: now + 60000, candleTime: market.candleTime };
}

function verifiedProtection(rows, entry, quantity) {
  const positionSide = (row) => row.posSide === 'net' && row.posMode === 'one_way_mode'
    ? ({ sell: 'long', buy: 'short' })[String(row.side).toLowerCase()]
    : ({ buy: 'long', sell: 'short', long: 'long', short: 'short' })[row.holdSide ?? row.posSide];
  const matching = rows.filter((row) => String(row.symbol).toUpperCase() === entry.symbol &&
    positionSide(row) === entry.side && row.planStatus === 'live' &&
    (Number(row.size) >= quantity || ['pos_loss', 'pos_profit'].includes(row.planType)));
  const matches = (row, stop) => {
    const trigger = Number(stop ? row.stopLossTriggerPrice || row.triggerPrice : row.stopSurplusTriggerPrice || row.triggerPrice);
    const execute = Number(stop ? row.stopLossExecutePrice || row.executePrice || 0 : row.stopSurplusExecutePrice || row.executePrice || 0);
    return (stop ? ['loss_plan', 'pos_loss'].includes(row.planType) : ['profit_plan', 'pos_profit'].includes(row.planType)) &&
      Math.abs(trigger - (stop ? entry.stop : entry.target)) <= entry.tick / 2 && execute === 0;
  };
  const stops = matching.filter(row => matches(row, true));
  const targets = matching.filter(row => matches(row, false));
  return stops.length && targets.length ? [...stops, ...targets] : [];
}

export function protectionMatches(rows, entry, quantity) {
  return verifiedProtection(rows, entry, quantity).length > 0;
}

async function closeEntry(entry, client, quantity, journal, save) {
  if (entry.closeId) return; // uncertain close is reconciled, never blindly retried
  entry.closeId = hash(entry.id + ':close');
  entry.status = 'closing';
  await save(journal);
  try { await client.close(entry, quantity); }
  catch { entry.status = 'close-unknown'; entry.message = 'Close outcome uncertain; check Bitget and reconcile'; }
  await save(journal);
}

async function reconcile(entry, client, journal, save, closeRequested, observedAt) {
  if (entry.status === 'preparing') { entry.status = 'rejected'; entry.message = 'Preparation interrupted before submission'; return; }
  if (closeRequested && !entry.closeRequested) { entry.closeRequested = true; await save(journal); }
  const detail = await client.detail(entry);
  if (!['live', 'partially_filled', 'filled', 'canceled'].includes(detail.state) ||
      !validQuantity(detail.baseVolume)) throw new Error('Invalid order status');
  entry.exchangeState = detail.state;
  entry.filled = Number(detail.baseVolume);
  // Observation time is explicit: exchange order update times are not necessarily fill times.
  if (entry.filled > 0) {
    entry.fillObservedAt ??= observedAt;
    if (positive(Number(detail.priceAvg))) entry.fillPrice = Number(detail.priceAvg);
  }
  const resting = ['live', 'partially_filled'].includes(detail.state);
  if (entry.action === 'close') {
    if (resting && (entry.cancelRequested || entry.closeRequested)) { await client.cancel(entry); entry.status = 'canceling'; }
    else entry.status = resting ? 'resting' : entry.filled > 0 ? 'closed' : 'unfilled';
    return;
  }
  if (resting && (entry.timeInForce !== 'gtc' || entry.closeRequested || entry.cancelRequested)) {
    // An IOC should not remain resting. Cancel residual quantity, then inspect fills again next cycle.
    await client.cancel(entry);
    entry.status = 'canceling';
    await save(journal);
    // Never close a possibly still-increasing fill until cancellation is confirmed.
    return;
  }
  if (entry.filled === 0) { entry.status = resting ? 'resting' : 'unfilled'; return; }
  const positions = await client.positions();
  validatePositions(positions);
  const position = positions.find((p) => p.symbol === entry.symbol && p.holdSide === entry.side && Number(p.total) > 0);
  if (!position && resting) { entry.cancelRequested = true; await save(journal); await client.cancel(entry); entry.status = 'canceling'; return; }
  if (!position) { entry.closedObservedAt ??= observedAt; entry.status = 'closed'; entry.message = 'No remaining exchange position'; return; }
  if (position.posMode !== 'one_way_mode' || !positive(Number(position.total)) || Number(position.total) > entry.filled + 1e-9) {
    journal.halted[entry.environment] = 'Position changed outside terminal; review on Bitget';
    entry.status = 'review'; return;
  }
  entry.positionQuantity = Number(position.total);
  if (entry.closeId) {
    const close = await client.detail(entry, true);
    entry.status = 'closing';
    if (['canceled', 'filled'].includes(close.state)) {
      journal.halted[entry.environment] = 'Close finished but exposure remains; review on Bitget';
      entry.status = 'review';
    }
    return;
  }
  let protectedPosition = false;
  let protectionRows = [];
  try { protectionRows = verifiedProtection(await client.protection(entry.symbol), entry, Number(position.total)); protectedPosition = protectionRows.length > 0; }
  catch { /* An unverified protective order is not protection. */ }
  entry.protected = protectedPosition;
  entry.protectionOrderIds = protectedPosition ? [...new Set(protectionRows.map(row => String(row.orderId ?? '')).filter(Boolean))] : [];
  entry.protectionVerifiedAt = protectedPosition ? observedAt : null;
  entry.status = resting ? 'partially-filled' : 'open';
  if (!protectedPosition || entry.closeRequested) {
    if (!protectedPosition) journal.halted[entry.environment] = 'Protection could not be verified; closing managed position';
    if (resting) { entry.closeRequested = true; await save(journal); await client.cancel(entry); entry.status = 'canceling'; }
    else await closeEntry(entry, client, Number(position.total), journal, save);
  } else {
    return protectionRows;
  }
}

export async function cycle(input, { clientFor, save, now = Date.now }) {
  const { settings, journal, connections, commands, marketState, paused } = input;
  validateSettings(settings); validateJournal(journal);
  journal.updatedAt = now(); journal.message = 'Waiting for a qualifying signal on Trade pairs';
  const validCommands = commands.filter((c) => !journal.handled.includes(c.id) && c.expiresAt >= now());
  const consumed = new Set();
  const verified = new Map();
  for (const entry of journal.entries.filter(activeEntry)) {
    const connection = connections[entry.environment];
    if (!connection?.credentials || connection.revision !== entry.connectionRevision) {
      journal.halted[entry.environment] = 'Original connection required to reconcile exposure'; continue;
    }
    try {
      const protection = await reconcile(entry, clientFor(entry.environment, connection.credentials, entry.apiVersion ?? 'v2'), journal, save,
        validCommands.some((c) => c.action === 'close' && c.entryId === entry.id && c.environment === entry.environment), now());
      if (protection) verified.set(entry.id, protection);
    } catch { entry.message = 'Exchange reconciliation unavailable; new entries blocked'; }
  }
  const previous = journal.proposals;
  journal.proposals = [];
  const environment = settings.environment;
  const connection = connections[environment];
  try {
    if (!connection?.credentials) throw new Error('Save separate ' + environment + ' trading credentials');
    const client = clientFor(environment, connection.credentials, connection.apiVersion ?? 'v2');
    const selection = validateMarkets(input.marketSelection === undefined ? defaultMarkets() : input.marketSelection);
    const enabled = new Set(selection.pairs.filter(p => p.watch && p.trade).map(p => p.symbol));
    if (journal.halted[environment]) throw new Error(journal.halted[environment]);
    const active = journal.entries.filter(activeEntry);
    if (active.some(entry => !verified.has(entry.id) || entry.environment !== environment || entry.status !== 'open' || !positive(entry.riskAmount)))
      throw new Error('Managing an existing or uncertain order');
    if (active.length >= (settings.maxConcurrent ?? 1) || (active.length && journal.demoTest))
      throw new Error('Concurrent position limit reached');
    const activeSymbols = new Set(active.map(entry => entry.symbol));
    const reservedRisk = active.reduce((total, entry) => total + entry.riskAmount, 0);
    if (journal.demoTest && (environment !== 'demo' || journal.demoTest.consumed || journal.demoTest.expiresAt < now())) throw new Error('Demo acceptance test stopped; save settings to return to strategy trading');
    if (!marketState || !Number.isFinite(marketState.updatedAt) || now() - marketState.updatedAt > 150000 || marketState.updatedAt > now() + 5000) throw new Error('Market monitor is stale');
    const recordAccount = context => {
      if (!positive(context.equity) || !Number.isFinite(context.available) || context.available < 0) throw new Error('Positive account equity required');
      journal.accounts[environment] = { equity: context.equity, available: context.available, updatedAt: now() };
      const date = new Date(now()).toISOString().slice(0, 10);
      if (journal.days[environment]?.date !== date) journal.days[environment] = { date, equity: context.equity };
      if (context.equity <= journal.days[environment].equity * (1 - settings.dailyLossPct / 100)) throw new Error('Daily equity-loss limit reached');
    };
    // Account-wide refresh has constant cost, regardless of the number of watched pairs.
    if (client.accountSnapshot && (!journal.accounts[environment]?.updatedAt || now() - journal.accounts[environment].updatedAt >= 15000)) recordAccount(await client.accountSnapshot());
    if (!settings.armed || paused) throw new Error('New entries are stopped; position monitoring continues');
    const candidates = (marketState.markets ?? []).filter(m => enabled.has(m.symbol) && symbolId(m.symbol) && !activeSymbols.has(symbolId(m.symbol)) &&
      (journal.demoTest ? m.symbol === journal.demoTest.symbol : scanAgent(m, now()).status === 'signal'));
    const eligible = new Set(candidates.map(m => m.symbol));
    journal.proposals = previous.filter(p => eligible.has(p.marketSymbol) && p.revision === settings.revision &&
      p.environment === environment && p.connectionRevision === connection.revision && p.expiresAt >= now());
    const offset = (journal.marketCursor ?? 0) % Math.max(1, candidates.length);
    const rotated = [...candidates.slice(offset), ...candidates.slice(0, offset)];
    const priority = m => validCommands.some(c => ['approve', 'reject'].includes(c.action) && c.revision === settings.revision &&
      journal.proposals.some(p => p.marketSymbol === m.symbol && p.id === c.proposalId && p.environment === c.environment));
    rotated.sort((a, b) => Number(priority(b)) - Number(priority(a)));
    // At most two full private preflights per cycle; approvals are checked first, others rotate fairly.
    journal.marketCursor = candidates.length ? (offset + 2) % candidates.length : 0;
    for (const market of rotated.slice(0, 2)) {
      journal.proposals = journal.proposals.filter(p => p.marketSymbol !== market.symbol);
      const context = await client.context(symbolId(market.symbol));
      recordAccount(context); // Entry risk always uses fresh private data, never the display cache.
      if (active.length) {
        const positions = context.positions;
        const orders = context.orders;
        const matchingOrder = (entry, row, order) => row.orderId && order.orderId && order.symbol === entry.symbol && String(row.orderId) === String(order.orderId);
        if (!Array.isArray(positions) || !Array.isArray(orders) || positions.length !== active.length ||
            !active.every(entry => positions.some(row => row.symbol === entry.symbol && row.holdSide === entry.side && row.posMode === "one_way_mode" && Number(row.total) === (entry.positionQuantity ?? entry.filled))) ||
            !active.every(entry => protectionMatches(verified.get(entry.id).filter(row => orders.some(order => matchingOrder(entry, row, order))), entry, entry.positionQuantity ?? entry.filled)) ||
            orders.some(order => !active.some(entry => verified.get(entry.id).some(row => matchingOrder(entry, row, order)))))
          throw new Error('Unmanaged exchange positions or orders block new entries');
        context.positions = [];
        context.orders = [];
      }
      const remainingRiskPct = settings.riskPct - reservedRisk / context.equity * 100;
      if (remainingRiskPct <= 0) throw new Error('Combined stop-risk budget is fully allocated');
      const sizing = { ...settings, riskPct: remainingRiskPct };
      let fresh;
      let evaluatedMarket = market;
      if (journal.demoTest) evaluatedMarket = { ...market, demoTestId: journal.demoTest.id, status: 'connected',
        candleTime: Math.floor(now() / 3600000) * 3600000 - 3600000, close: context.price,
        lower: context.price * 1.01, upper: context.price * 1.1, previousClose: context.price * 1.02,
        previousLower: context.price * 1.01, previousUpper: context.price * 1.1, rsi: 20 };
      try { fresh = makeProposal(evaluatedMarket, context, journal.demoTest ? { ...sizing, maxNotional: Math.min(settings.maxNotional, 20) } : sizing, connection, now()); }
      catch (error) { journal.message = error.message; continue; }
      if (journal.entries.some((entry) => entry.id === fresh.id)) continue;
      const existing = previous.find((p) => p.id === fresh.proposalId && p.expiresAt >= now());
      const proposal = existing ?? { ...fresh, entryId: fresh.id, id: fresh.proposalId };
      const command = validCommands.find((c) => c.environment === environment && c.revision === settings.revision && c.proposalId === proposal.id);
      if (command) consumed.add(command.id);
      if (command?.action === 'reject') {
        journal.entries.push({ ...fresh, status: 'rejected', message: 'Rejected by operator' }); continue;
      }
      if (settings.mode !== 'automatic' && command?.action !== 'approve') { journal.proposals.push(proposal); continue; }
      // Approval authorizes the displayed quantity and bounds, never a newly enlarged order.
      const entry = { ...proposal, id: proposal.entryId, status: 'preparing', updatedAt: now() };
      if (entry.quantity > fresh.quantity || Math.abs(context.price / (entry.limit / (entry.side === 'long' ? 1.002 : 0.998)) - 1) > 0.002 ||
          entry.quantity * entry.limit > settings.maxNotional || entry.riskAmount + reservedRisk > context.equity * settings.riskPct / 100) {
        journal.message = 'Proposal changed; review a fresh proposal'; continue;
      }
      if ((await client.protection(entry.symbol)).length) throw new Error('Existing protective orders require review before a new entry');
      if (entry.expiresAt < now() || now() - context.quoteTime > 15000) throw new Error('Price expired during order checks');
      journal.entries.push(entry);
      if (journal.demoTest) journal.demoTest.consumed = true;
      await save(journal); // intent must survive a process crash before submission
      try {
        const verifiedContext = await ensureLeverage(client, entry, context);
        if (entry.expiresAt < now() || now() - verifiedContext.quoteTime > 15000 || Math.abs(verifiedContext.price / context.price - 1) > 0.002) throw new Error('Quote expired');
      } catch { entry.status = 'rejected'; entry.message = 'Leverage or fresh quote verification failed; no order submitted'; await save(journal); break; }
      entry.status = 'submitting'; await save(journal);
      try { const result = await client.submit(entry); entry.orderId = result.orderId; entry.status = 'submitted'; }
      catch { entry.status = 'unknown'; entry.message = 'Submission outcome uncertain; reconciling without resubmission'; }
      await save(journal);
      journal.proposals = []; break;
    }
  } catch (error) { journal.message = error.message; }
  journal.handled.push(...commands.filter(c => !journal.handled.includes(c.id) &&
    (consumed.has(c.id) || !['approve', 'reject'].includes(c.action) || c.expiresAt < now() || c.revision !== settings.revision)).map(c => c.id));
  journal.updatedAt = now();
  await save(journal);
  return journal;
}

// Mutations occur only after durable authorized intent, never during a preview.
export async function ensureLeverage(client, entry, context) {
  const desired = entry.leverage ?? 1;
  if (!Number.isInteger(desired) || desired < 1 || desired > 20) throw new Error('Invalid leverage');
  const key = entry.side === 'long' ? 'isolatedLongLever' : 'isolatedShortLever';
  if (context.account?.posMode !== 'one_way_mode' || context.account?.marginMode !== 'isolated') throw new Error('One-way isolated mode required');
  if (Number(context.account[key]) === desired) return context;
  if (context.positions.some(p => p.symbol === entry.symbol) || context.orders.some(o => o.symbol === entry.symbol)) throw new Error('Cannot change leverage with existing exposure');
  await client.setLeverage(entry);
  const fresh = await client.context(entry.symbol);
  if (fresh.account?.posMode !== 'one_way_mode' || fresh.account?.marginMode !== 'isolated' || Number(fresh.account[key]) !== desired) throw new Error('Exchange leverage verification failed');
  if (fresh.positions.some(p => p.symbol === entry.symbol && Number(p.total) > 0) || fresh.orders.some(o => o.symbol === entry.symbol)) throw new Error('Exposure changed during leverage verification');
  if (entry.quantity * entry.limit / desired > fresh.available * 0.99) throw new Error('Available margin changed');
  return fresh;
}
