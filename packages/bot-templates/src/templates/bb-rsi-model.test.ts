import { describe, expect, it } from "vitest";
import { backtestBbRsi, bbRsiSignal } from "./bb-rsi-model.js";

const hour = 3_600_000;
const candles = (closes: number[]) =>
  closes.map((close, i) => ({ timestamp: i * hour, open: close, high: close, low: close, close, volume: 0 }));

describe("BB/RSI", () => {
  it("requires a fresh crossing in either direction", () => {
    const flat = Array<number>(20).fill(100);
    expect(bbRsiSignal(candles([...flat, 80]))).toBe("long");
    expect(bbRsiSignal(candles([...flat, 120]))).toBe("short");
    expect(bbRsiSignal(candles([...flat, 120, 121]))).toBeUndefined();
    expect(bbRsiSignal(candles(flat))).toBeUndefined();
  });

  it("fills at the next open and gives the stop priority when both triggers trade", () => {
    const bars = candles([...Array<number>(20).fill(100), 120, 100]);
    Object.assign(bars[21]!, { high: 103, low: 95 });
    const result = backtestBbRsi(bars, 1000);
    expect(result.trades).toEqual([
      { side: "short", entry: 100, exit: 102, quantity: 10, reason: "stop", pnl: -20 },
    ]);
    expect(result.equity).toBe(980);
  });
});
