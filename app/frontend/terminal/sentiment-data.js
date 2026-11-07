export function parseSentiment(payload, now = Date.now()) {
  const item = payload?.data?.[0];
  if (!item || !/^\d{1,3}$/.test(String(item.value))) throw new Error('Invalid sentiment');
  const value = Number(item.value), timestamp = Number(item.timestamp) * 1000;
  if (value > 100 || !Number.isFinite(timestamp) || timestamp <= 0 || timestamp > now + 300000)
    throw new Error('Invalid sentiment date or score');
  const labels = { 'Extreme Fear': 'Extreme fear', Fear: 'Fear', Neutral: 'Neutral', Greed: 'Greed', 'Extreme Greed': 'Extreme greed' };
  const label = Object.hasOwn(labels, item.value_classification) ? labels[item.value_classification] : null;
  if (!label) throw new Error('Invalid sentiment classification');
  return { value, label, timestamp, stale: now - timestamp > 48 * 3600000 };
}
