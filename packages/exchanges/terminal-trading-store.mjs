import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const tradingPath = () => process.env.TERMINAL_TRADING_PATH ?? '/trading';
export const defaultSettings = () => ({ revision: 'initial', environment: 'demo', mode: 'approval', armed: false,
  maxNotional: 100, riskPct: 2, dailyLossPct: 3, maxConcurrent: 1, leverage: 1, orderType: 'limit', stopLossPct: 2, takeProfitPct: 4, direction: 'both' });
export function validateSettings(value) {
  if (!value || !['demo', 'live'].includes(value.environment) || !['approval', 'automatic'].includes(value.mode) ||
      typeof value.armed !== 'boolean' || typeof value.revision !== 'string') throw new Error('Invalid trading settings');
  for (const [key, min, max] of [['maxNotional', 5, 10000], ['riskPct', 0.1, 2], ['dailyLossPct', 0.1, 10]]) {
    if (!Number.isFinite(value[key]) || value[key] < min || value[key] > max) throw new Error('Invalid trading limits');
  }
  const maxConcurrent = value.maxConcurrent ?? 1;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 5) throw new Error("Invalid concurrent position limit");
  if (!Number.isInteger(value.leverage ?? 1) || (value.leverage ?? 1) < 1 || (value.leverage ?? 1) > 20 ||
      !['limit', 'market'].includes(value.orderType ?? 'limit') || !['both', 'long', 'short'].includes(value.direction ?? 'both')) throw new Error('Invalid futures controls');
  for (const key of ['stopLossPct', 'takeProfitPct']) {
    const n = value[key] ?? (key === 'stopLossPct' ? 2 : 4);
    if (!Number.isFinite(n) || n < 0.1 || n > 50) throw new Error('Invalid protective percentage');
  }
  return value;
}
export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('Trading storage is unavailable'); }
}
export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  await rename(temp, path);
}
// Cross-process exclusion covers config writes, commands and network submissions.
// A crash leaves this directory behind deliberately: never guess that a trading lock is stale.
export async function withTradingLock(directory, action) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, '.lock');
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await mkdir(lock); acquired = true; break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!acquired) throw new Error('Trading worker busy or recovery lock present');
  try { return await action(); } finally { await rm(lock, { recursive: true }); }
}
export const emptyJournal = () => ({ version: 1, entries: [], proposals: [], days: {}, halted: {}, handled: [], accounts: {} });
export function validateJournal(value) {
  if (value?.version !== 1 || !Array.isArray(value.entries) || !Array.isArray(value.proposals) ||
      !Array.isArray(value.handled) || !value.days || !value.halted || !value.accounts) throw new Error('Invalid trading journal');
  return value;
}
export const activeEntry = (entry) => !['closed', 'unfilled', 'rejected'].includes(entry.status);
