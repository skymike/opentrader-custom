export function parseSentiment(payload, now = Date.now()) {
  const item = payload?.data?.[0];
  if (!item || !/^\d{1,3}$/.test(String(item.value))) throw new Error('Invalid sentiment');
  const value = Number(item.value), timestamp = Number(item.timestamp) * 1000;
  if (value > 100 || !Number.isFinite(timestamp) || timestamp <= 0 || timestamp > now + 300000)
    throw new Error('Invalid sentiment date or score');
  const label = value <= 24 ? 'Extreme fear' : value <= 44 ? 'Fear' : value <= 55 ? 'Neutral' : value <= 74 ? 'Greed' : 'Extreme greed';
  return { value, label, timestamp, stale: now - timestamp > 48 * 3600000 };
}
