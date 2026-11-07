import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSentiment } from './sentiment-data.js';
const now = Date.UTC(2026, 10, 7, 12);
const payload = (value = '27', timestamp = now / 1000 - 43200) => ({ data: [{ value, value_classification: 'Fear', timestamp: String(timestamp) }] });
test('accepts a dated daily reading including zero and marks old data stale', () => {
  assert.deepEqual(parseSentiment(payload(), now), { value: 27, label: 'Fear', timestamp: now - 43200000, stale: false });
  assert.equal(parseSentiment(payload('0'), now).value, 0);
  assert.equal(parseSentiment(payload('27', now / 1000 - 3 * 86400), now).stale, true);
});
test('rejects malformed, out of range and future readings instead of presenting neutral sentiment', () => {
  for (const value of ['', null, 'NaN', '-1', '101', '2.5']) assert.throws(() => parseSentiment(payload(value), now));
  assert.throws(() => parseSentiment({ data: [] }, now));
  assert.throws(() => parseSentiment(payload('27', now / 1000 + 3600), now));
});
