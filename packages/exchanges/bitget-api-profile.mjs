import { readFileSync } from 'node:fs';
import { join } from 'node:path';
export const apiProfilePath = () => join(process.env.TERMINAL_TRADING_PATH ?? '/trading', 'opentrader-api.json');
export function readApiProfiles() {
  try { const value = JSON.parse(readFileSync(apiProfilePath(), 'utf8'));
    if (!value || typeof value !== 'object' || Object.values(value).some((v) => !['v2', 'v3'].includes(v))) throw new Error('Invalid API profiles');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('API profiles unavailable'); }
}
export function getBitgetApiVersion(id) { return readApiProfiles()[String(id)] ?? 'v2'; }
export function applyBitgetApi(client, apiVersion) {
  if (!['v2', 'v3'].includes(apiVersion)) throw new Error('Choose Classic V2 or Unified V3');
  client.options.uta = apiVersion === 'v3';
  client.options.defaultType = 'swap';
}
