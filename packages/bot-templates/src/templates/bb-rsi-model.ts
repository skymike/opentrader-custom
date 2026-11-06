import type { ICandlestick } from "@opentrader/types";

type Side = "long" | "short";
const hour = 3_600_000;

function bands(candles: ICandlestick[]) {
  const mean = candles.reduce((sum, bar) => sum + bar.close, 0) / 20;
  const variance = candles.reduce((sum, bar) => sum + (bar.close - mean) ** 2, 0) / 20;
  const width = 2 * Math.sqrt(variance);
  return { lower: mean - width, upper: mean + width };
}

function rsi(candles: ICandlestick[]) {
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < candles.length; i++) {
    const change = candles[i]!.close - candles[i - 1]!.close;
    const up = Math.max(0, change);
    const down = Math.max(0, -change);
    gain = i <= 14 ? gain + up / 14 : (13 * gain + up) / 14;
    loss = i <= 14 ? loss + down / 14 : (13 * loss + down) / 14;
  }
  return gain + loss === 0 ? 50 : (100 * gain) / (gain + loss);
}

export function bbRsiSignal(candles: ICandlestick[]): Side | undefined {
  if (candles.length < 21) return;
  const previous = candles.at(-2)!;
  const latest = candles.at(-1)!;
  if (latest.timestamp - previous.timestamp !== hour) return;

  const priorBand = bands(candles.slice(-21, -1));
  const currentBand = bands(candles.slice(-20));
  const strength = rsi(candles);
  if (previous.close >= priorBand.lower && latest.close < currentBand.lower && strength < 30) return "long";
  if (previous.close <= priorBand.upper && latest.close > currentBand.upper && strength > 70) return "short";
}

export function backtestBbRsi(candles: ICandlestick[], startingEquity: number) {
  let equity = startingEquity;
  let pending: Side | undefined;
  let position: { side: Side; entry: number; quantity: number } | undefined;
  const trades = [];

  for (const [i, bar] of candles.entries()) {
    if (i > 0 && bar.timestamp - candles[i - 1]!.timestamp !== hour) {
      throw new Error("BB/RSI requires contiguous one-hour candles");
    }
    if (pending && equity > 0) {
      // A 2% risk budget and 2% stop imply a 1x notional position before costs.
      position = { side: pending, entry: bar.open, quantity: equity / bar.open };
      pending = undefined;
    }
    if (position) {
      const { side, entry, quantity } = position;
      const long = side === "long";
      const stop = entry * (long ? 0.98 : 1.02);
      const target = entry * (long ? 1.04 : 0.96);
      const hitStop = long ? bar.low <= stop : bar.high >= stop;
      const hitTarget = long ? bar.high >= target : bar.low <= target;
      if (hitStop || hitTarget) {
        const exit = hitStop ? (long ? Math.min(stop, bar.open) : Math.max(stop, bar.open)) : target;
        const pnl = (exit - entry) * quantity * (long ? 1 : -1);
        equity += pnl;
        trades.push({ side, entry, exit, quantity, reason: hitStop ? "stop" : "target", pnl });
        position = undefined;
      }
    }
    if (!position) pending = bbRsiSignal(candles.slice(Math.max(0, i - 199), i + 1));
  }

  return { startingEquity, equity, trades, openPosition: position ?? null };
}
