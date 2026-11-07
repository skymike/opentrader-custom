export function normalizeCandles(rows) {
  const result = new Map();
  for (const row of rows ?? []) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [stamp, open, high, low, close, volume] = row.slice(0, 6).map(Number);
    if (
      ![stamp, open, high, low, close, volume].every(Number.isFinite) ||
      stamp <= 0 ||
      low <= 0 ||
      volume < 0 ||
      high < Math.max(open, close, low) ||
      low > Math.min(open, close)
    )
      continue;
    const time = Math.floor(stamp / 1000);
    result.set(time, { time, open, high, low, close, volume });
  }
  return [...result.values()].sort((a, b) => a.time - b.time);
}
export function indicators(candles) {
  const upper = [],
    middle = [],
    lower = [],
    rsi = [];
  let gain = 0,
    loss = 0;
  candles.forEach((c, i) => {
    if (i >= 19) {
      const values = candles.slice(i - 19, i + 1).map((c) => c.close);
      const mean = values.reduce((a, b) => a + b, 0) / 20;
      const width = 2 * Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / 20);
      upper.push({ time: c.time, value: mean + width });
      middle.push({ time: c.time, value: mean });
      lower.push({ time: c.time, value: mean - width });
    }
    if (i > 0) {
      const delta = c.close - candles[i - 1].close;
      gain = i <= 14 ? gain + Math.max(delta, 0) / 14 : (13 * gain + Math.max(delta, 0)) / 14;
      loss = i <= 14 ? loss + Math.max(-delta, 0) / 14 : (13 * loss + Math.max(-delta, 0)) / 14;
      if (i >= 14) rsi.push({ time: c.time, value: gain + loss ? (100 * gain) / (gain + loss) : 50 });
    }
  });
  return { upper, middle, lower, rsi };
}
