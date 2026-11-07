import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { MAX_MARKETS, readMarkets, readCatalog, marketsPath, validateMarkets } from './terminal-markets.mjs';
import { tradingPath, readJson, atomicJson, withTradingLock, defaultSettings, emptyJournal, validateJournal } from './terminal-trading-store.mjs';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const fresh = catalog => catalog.updatedAt <= Date.now() + 5000 && Date.now() - catalog.updatedAt < 120000;
export function registerMarkets(app, authorize) {
  const present = async () => {
    const selection = await readMarkets(), catalog = await readCatalog();
    const settings = await readJson(join(tradingPath(), 'settings.json'), defaultSettings());
    return { ...selection, maxMarkets: MAX_MARKETS, catalog: catalog.markets, catalogUpdatedAt: catalog.updatedAt,
      catalogFresh: fresh(catalog), trading: { armed: settings.armed, environment: settings.environment, mode: settings.mode } };
  };
  const guarded = fn => async (request, reply) => {
    try { return await fn(request); }
    catch (error) { return reply.code(error.status ?? 503).send({ message: error.status ? error.message : 'Market settings unavailable. Retry shortly.' }); }
  };
  app.get('/api/terminal/markets', { preHandler: authorize }, guarded(present));
  app.put('/api/terminal/markets', { preHandler: authorize, bodyLimit: 16384 }, guarded(request => withTradingLock(tradingPath(), async () => {
    const current = await readMarkets(), catalog = await readCatalog(), body = request.body;
    if (body?.revision !== current.revision) fail(409, 'Pairs changed. Refresh and try again.');
    let pairs = body.pairs;
    if (body.action === 'top10') {
      if (!fresh(catalog) || !catalog.markets.length) fail(503, 'Live market list is refreshing. Try again shortly.');
      const merged = new Map(current.pairs.map(pair => [pair.symbol, pair]));
      for (const market of catalog.markets.slice(0, 10)) merged.set(market.symbol, { symbol: market.symbol, watch: true, trade: merged.get(market.symbol)?.trade ?? false });
      pairs = [...merged.values()];
    }
    const next = { version: 1, revision: randomUUID(), pairs };
    try { validateMarkets(next); } catch { fail(400, `Choose up to ${MAX_MARKETS} unique USDT perpetual pairs. Trade requires Watch.`); }
    for (const pair of pairs) {
      const old = current.pairs.find(p => p.symbol === pair.symbol);
      if ((!old || (!old.watch && pair.watch) || (!old.trade && pair.trade))) {
        if (!fresh(catalog)) fail(503, 'Live market list is refreshing. Try again shortly.');
        if (!catalog.markets.some(m => m.symbol === pair.symbol)) fail(400, 'Choose an available Bitget USDT perpetual pair.');
      }
    }
    const trades = values => values.filter(p => p.trade).map(p => p.symbol).sort().join(',');
    if (trades(pairs) !== trades(current.pairs)) {
      // Disarm first: a crash between writes cannot activate a changed trade universe.
      const path = join(tradingPath(), 'settings.json');
      const settings = await readJson(path, defaultSettings());
      await atomicJson(path, { ...settings, armed: false, revision: randomUUID() });
      const journal = validateJournal(await readJson(join(tradingPath(), 'journal.json'), emptyJournal()));
      journal.proposals = []; delete journal.demoTest;
      await atomicJson(join(tradingPath(), 'journal.json'), journal);
    }
    await atomicJson(marketsPath(), next);
    return present();
  })));
}
