import { createBitget } from './terminal-bitget.mjs';
import { createBitgetV3 } from './terminal-bitget-v3.mjs';
export function createTradingClient(environment, credentials, apiVersion = 'v2') {
  if (!['v2', 'v3'].includes(apiVersion)) throw new Error('Choose Classic V2 or Unified V3');
  return apiVersion === 'v3' ? createBitgetV3(environment, credentials) : createBitget(environment, credentials);
}
