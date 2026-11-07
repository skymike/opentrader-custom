import type { ExchangeCode } from "@opentrader/types";

export interface IExchangeCredentials {
  bitgetApiVersion?: 'v2' | 'v3';
  code: ExchangeCode;
  apiKey: string;
  secretKey: string;
  password: string; // or password (depends on the exchange)
  isDemoAccount: boolean;
  isPaperAccount: boolean;
}
