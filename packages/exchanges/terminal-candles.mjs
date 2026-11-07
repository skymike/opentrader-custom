export function summarizeCandles(rows, now = Date.now()) {
  const hour = 3_600_000;
  const latest = Math.floor(now / hour) * hour - hour;
  const candles = rows.filter(([time]) => time <= latest);
  if (candles.length < 21 || candles.at(-1)[0] !== latest || candles.some((row, index) =>
    !Number.isFinite(row[4]) || row[4] <= 0 || (index && row[0] - candles[index - 1][0] !== hour))) {
    throw new Error("Incomplete hourly candles");
  }
  const closes = candles.map((row) => row[4]);
  const window = closes.slice(-20);
  const middle = window.reduce((sum, value) => sum + value, 0) / 20;
  const width = 2 * Math.sqrt(window.reduce((sum, value) => sum + (value - middle) ** 2, 0) / 20);
  const prior = closes.slice(-21, -1);
  const previousMiddle = prior.reduce((sum, value) => sum + value, 0) / 20;
  const previousWidth = 2 * Math.sqrt(prior.reduce((sum, value) => sum + (value - previousMiddle) ** 2, 0) / 20);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    gain = i <= 14 ? gain + Math.max(change, 0) / 14 : (13 * gain + Math.max(change, 0)) / 14;
    loss = i <= 14 ? loss + Math.max(-change, 0) / 14 : (13 * loss + Math.max(-change, 0)) / 14;
  }
  return { lower: middle - width, middle, upper: middle + width, rsi: gain + loss ? 100 * gain / (gain + loss) : 50,
    previousClose: closes.at(-2), previousLower: previousMiddle - previousWidth, previousUpper: previousMiddle + previousWidth,
    candleTime: latest, close: closes.at(-1), history: candles.slice(-48).map((row) => [row[0], row[4]]) };
}
