import { createHash } from 'node:crypto';
import { scanAgent } from './classic-agents.mjs';
import { activeEntry, validateJournal, validateSettings } from './terminal-trading-store.mjs';
import { validQuantity, validatePositions } from './terminal-bitget.mjs';

const positive = (n) => Number.isFinite(n) && n > 0;
const hash = (value) => 'ot' + createHash('sha256').update(value).digest('hex').slice(0, 28);
const round = (n, step, direction = Math.floor) => Number((direction(n / step + 1e-9) * step).toPrecision(12));
const symbolId = (symbol) => ({ 'BTC/USDT:USDT': 'BTCUSDT', 'SOL/USDT:USDT': 'SOLUSDT' })[symbol];

export function makeProposal(market, context, settings, connection, now) {
  const signal = scanAgent({ ...market, price: context.price }, now);
  if (signal.status !== 'signal') throw new Error(signal.reason);
  const { account: a, rules: r } = context;
  if (!positive(context.equity) || !positive(context.available) || !positive(context.price) ||
      !Number.isFinite(context.quoteTime) || now - context.quoteTime > 15000 || context.quoteTime > now + 5000) throw new Error('Fresh account and price required');
  if (a?.posMode !== 'one_way_mode' || a?.marginMode !== 'isolated' ||
      Number(a.isolatedLongLever) !== 1 || Number(a.isolatedShortLever) !== 1) throw new Error('Set this market to one-way, isolated margin and 1x leverage in Bitget');
  if (!Array.isArray(context.positions) || !Array.isArray(context.orders) || context.positions.length || context.orders.length) throw new Error('Existing exchange positions or orders block new entries');
  if (!r || r.status !== 'normal' || ![r.step, r.tick, r.minSize, r.minCost, r.maxSize].every(positive)) throw new Error('Exchange trading rules unavailable');
  if (Math.abs(context.price / market.close - 1) > 0.01) throw new Error('Price moved more than 1% from signal close');
  const long = signal.side === 'long';
  const limit = round(context.price * (long ? 1.002 : 0.998), r.tick, long ? Math.floor : Math.ceil);
  const stop = round(context.price * (long ? 0.98 : 1.02), r.tick, long ? Math.ceil : Math.floor);
  const target = round(context.price * (long ? 1.04 : 0.96), r.tick, long ? Math.floor : Math.ceil);
  const unitRisk = Math.abs(limit - stop) + limit * 0.002; // reserve for fees/slippage; gaps remain possible
  const quantity = round(Math.min(settings.maxNotional / limit, context.available * 0.99 / limit,
    context.equity * settings.riskPct / 100 / unitRisk, r.maxSize), r.step);
  if (![limit, stop, target, quantity].every(positive) || quantity < r.minSize || quantity * limit < r.minCost ||
      !(long ? stop < limit && limit < target : target < limit && limit < stop)) throw new Error('Order is below exchange minimum or prices are invalid');
  const id = hash([settings.environment, connection.revision, market.symbol, market.candleTime, signal.side, market.demoTestId ?? 'strategy'].join(':'));
  return { id, proposalId: hash(id + settings.revision), environment: settings.environment, revision: settings.revision,
    connectionRevision: connection.revision, apiVersion: connection.apiVersion ?? 'v2', symbol: symbolId(market.symbol), marketSymbol: market.symbol, side: signal.side,
    quantity, limit, stop, target, riskAmount: quantity * unitRisk, tick: r.tick, source: market.demoTestId ? 'demo-test' : 'strategy',
    createdAt: now, expiresAt: now + 60000, candleTime: market.candleTime };
}

export function protectionMatches(rows, entry, quantity) {
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
  return matching.some((row) => matches(row, true)) && matching.some((row) => matches(row, false));
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
  if (['live', 'partially_filled'].includes(detail.state)) {
    // An IOC should not remain resting. Cancel residual quantity, then inspect fills again next cycle.
    await client.cancel(entry);
    entry.status = 'canceling';
    await save(journal);
    // Never close a possibly still-increasing fill until cancellation is confirmed.
    return;
  }
  if (entry.filled === 0) { entry.status = 'unfilled'; return; }
  const positions = await client.positions();
  validatePositions(positions);
  const position = positions.find((p) => p.symbol === entry.symbol && p.holdSide === entry.side && Number(p.total) > 0);
  if (!position) { entry.closedObservedAt ??= observedAt; entry.status = 'closed'; entry.message = 'No remaining exchange position'; return; }
  if (position.posMode !== 'one_way_mode' || !positive(Number(position.total)) || Number(position.total) > entry.filled + 1e-9) {
    journal.halted[entry.environment] = 'Position changed outside terminal; review on Bitget';
    entry.status = 'review'; return;
  }
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
  try { protectedPosition = protectionMatches(await client.protection(entry.symbol), entry, Number(position.total)); }
  catch { /* An unverified protective order is not protection. */ }
  entry.protected = protectedPosition;
  entry.status = 'open';
  if (!protectedPosition || entry.closeRequested) {
    if (!protectedPosition) journal.halted[entry.environment] = 'Protection could not be verified; closing managed position';
    await closeEntry(entry, client, Number(position.total), journal, save);
  }
}

export async function cycle(input, { clientFor, save, now = Date.now }) {
  const { settings, journal, connections, commands, marketState, paused } = input;
  validateSettings(settings); validateJournal(journal);
  journal.updatedAt = now(); journal.message = 'Waiting for a qualifying BTC/SOL signal';
  const validCommands = commands.filter((c) => !journal.handled.includes(c.id) && c.expiresAt >= now());
  for (const entry of journal.entries.filter(activeEntry)) {
    const connection = connections[entry.environment];
    if (!connection?.credentials || connection.revision !== entry.connectionRevision) {
      journal.halted[entry.environment] = 'Original connection required to reconcile exposure'; continue;
    }
    try {
      await reconcile(entry, clientFor(entry.environment, connection.credentials, entry.apiVersion ?? 'v2'), journal, save,
        validCommands.some((c) => c.action === 'close' && c.entryId === entry.id && c.environment === entry.environment), now());
    } catch { entry.message = 'Exchange reconciliation unavailable; new entries blocked'; }
  }
  const previous = journal.proposals;
  journal.proposals = [];
  const environment = settings.environment;
  const connection = connections[environment];
  try {
    if (!connection?.credentials) throw new Error('Save separate ' + environment + ' trading credentials');
    const client = clientFor(environment, connection.credentials, connection.apiVersion ?? 'v2');
    if (journal.halted[environment]) throw new Error(journal.halted[environment]);
    if (journal.entries.some(activeEntry)) throw new Error('Managing an existing or uncertain order');
    if (journal.demoTest && (environment !== 'demo' || journal.demoTest.consumed || journal.demoTest.expiresAt < now())) throw new Error('Demo acceptance test stopped; save settings to return to strategy trading');
    if (!marketState || !Number.isFinite(marketState.updatedAt) || now() - marketState.updatedAt > 150000 || marketState.updatedAt > now() + 5000) throw new Error('Market monitor is stale');
    for (const market of marketState.markets ?? []) {
      if (!symbolId(market.symbol)) continue;
      if (journal.demoTest && market.symbol !== journal.demoTest.symbol) continue;
      const context = await client.context(symbolId(market.symbol));
      journal.accounts[environment] = { equity: context.equity, available: context.available, updatedAt: now() };
      if (!positive(context.equity)) throw new Error('Positive account equity required');
      const date = new Date(now()).toISOString().slice(0, 10);
      if (journal.days[environment]?.date !== date) journal.days[environment] = { date, equity: context.equity };
      if (context.equity <= journal.days[environment].equity * (1 - settings.dailyLossPct / 100)) throw new Error('Daily equity-loss limit reached');
      if (!settings.armed || paused) throw new Error('New entries are stopped; position monitoring continues');
      let fresh;
      let evaluatedMarket = market;
      if (journal.demoTest) evaluatedMarket = { ...market, demoTestId: journal.demoTest.id, status: 'connected',
        candleTime: Math.floor(now() / 3600000) * 3600000 - 3600000, close: context.price,
        lower: context.price * 1.01, upper: context.price * 1.1, previousClose: context.price * 1.02,
        previousLower: context.price * 1.01, previousUpper: context.price * 1.1, rsi: 20 };
      try { fresh = makeProposal(evaluatedMarket, context, journal.demoTest ? { ...settings, maxNotional: Math.min(settings.maxNotional, 20) } : settings, connection, now()); }
      catch (error) { journal.message = error.message; continue; }
      if (journal.entries.some((entry) => entry.id === fresh.id)) continue;
      const existing = previous.find((p) => p.id === fresh.proposalId && p.expiresAt >= now());
      const proposal = existing ?? { ...fresh, entryId: fresh.id, id: fresh.proposalId };
      const command = validCommands.find((c) => c.environment === environment && c.revision === settings.revision && c.proposalId === proposal.id);
      if (command?.action === 'reject') {
        journal.entries.push({ ...fresh, status: 'rejected', message: 'Rejected by operator' }); continue;
      }
      if (settings.mode !== 'automatic' && command?.action !== 'approve') { journal.proposals.push(proposal); continue; }
      // Approval authorizes the displayed quantity and bounds, never a newly enlarged order.
      const entry = { ...proposal, id: proposal.entryId, status: 'submitting', updatedAt: now() };
      if (entry.quantity > fresh.quantity || Math.abs(context.price / (entry.limit / (entry.side === 'long' ? 1.002 : 0.998)) - 1) > 0.002 ||
          entry.quantity * entry.limit > settings.maxNotional || entry.riskAmount > context.equity * settings.riskPct / 100) {
        journal.message = 'Proposal changed; review a fresh proposal'; continue;
      }
      if ((await client.protection(entry.symbol)).length) throw new Error('Existing protective orders require review before a new entry');
      if (entry.expiresAt < now() || now() - context.quoteTime > 15000) throw new Error('Price expired during order checks');
      journal.entries.push(entry);
      if (journal.demoTest) journal.demoTest.consumed = true;
      await save(journal); // intent must survive a process crash before submission
      try { const result = await client.submit(entry); entry.orderId = result.orderId; entry.status = 'submitted'; }
      catch { entry.status = 'unknown'; entry.message = 'Submission outcome uncertain; reconciling without resubmission'; }
      await save(journal);
      journal.proposals = []; break;
    }
  } catch (error) { journal.message = error.message; }
  journal.handled.push(...commands.filter((c) => !journal.handled.includes(c.id)).map((c) => c.id));
  journal.updatedAt = now();
  await save(journal);
  return journal;
}
