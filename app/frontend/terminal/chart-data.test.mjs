import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCandles, indicators } from "./chart-data.js";
test("normalizes, sorts and deduplicates candles; rejects impossible prices", () => {
  const rows = [
    [2000, 2, 3, 1, 2, 4],
    [1000, "1", "2", "1", "2", "3"],
    [2000, 2, 4, 1, 3, 5],
    [3000, 2, 1, 3, 2, 4],
    [4000, 1, 2, 1, "NaN", 3],
  ];
  assert.deepEqual(
    normalizeCandles(rows).map((c) => [c.time, c.close]),
    [
      [1, 2],
      [2, 3],
    ],
  );
});
test("flat data gives RSI 50 and flat Bollinger bands after warmup", () => {
  const data = Array.from({ length: 30 }, (_, i) => ({ time: i + 1, close: 100 }));
  const value = indicators(data);
  assert.equal(value.rsi[0].time, 15);
  assert.equal(value.rsi.at(-1).value, 50);
  assert.equal(value.upper[0].time, 20);
  assert.equal(value.lower.at(-1).value, 100);
});
test("Wilder RSI handles all gains and all losses", () => {
  assert.equal(indicators(Array.from({ length: 30 }, (_, i) => ({ time: i + 1, close: i + 1 }))).rsi.at(-1).value, 100);
  assert.equal(indicators(Array.from({ length: 30 }, (_, i) => ({ time: i + 1, close: 40 - i }))).rsi.at(-1).value, 0);
});
