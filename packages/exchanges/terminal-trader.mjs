import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tradingPath, defaultSettings, emptyJournal, readJson, atomicJson, withTradingLock } from './terminal-trading-store.mjs';
import { createTradingClient } from './terminal-exchange-router.mjs';
import { cycle } from './terminal-execution.mjs';

export async function tick(directory = tradingPath()) {
  return withTradingLock(directory, async () => {
    const settings = await readJson(join(directory, 'settings.json'), defaultSettings());
    const connections = await readJson(join(directory, 'connections.json'), {});
    const journal = await readJson(join(directory, 'journal.json'), emptyJournal());
    const commands = await readJson(join(directory, 'commands.json'), []);
    let marketState = null, paused = true;
    try { marketState = await readJson(process.env.TERMINAL_STATE_PATH ?? '/terminal/state.json', null); } catch { /* fail closed */ }
    try { paused = (await readJson(process.env.TERMINAL_CONTROL_PATH ?? '/credentials/control.json', { paused: false })).paused !== false; } catch { /* fail closed */ }
    const save = (value) => atomicJson(join(directory, 'journal.json'), value);
    return cycle({ settings, connections, journal, commands, marketState, paused }, { clientFor: createTradingClient, save });
  });
}
export async function trader() {
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
  do {
    try { await tick(); }
    catch { console.error('Trading cycle unavailable. Check storage, recovery lock and exchange connectivity.'); }
    if (process.argv.includes('--once') || stopping) break;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  } while (!stopping);
  } finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void trader();
