import test from "node:test";
import assert from "node:assert/strict";
import { botOverlays } from "./bot-overlays.js";
const candles = [{ time: 100 }, { time: 200 }, { time: 300 }];
const state = {
  settings: { environment: "demo" },
  stale: false,
  journal: {
    entries: [
      {
        id: "a",
        environment: "demo",
        symbol: "BTCUSDT",
        side: "long",
        status: "open",
        filled: 1,
        fillPrice: 102,
        fillObservedAt: 205000,
        stop: 98,
        target: 110,
        protected: true,
      },
    ],
    proposals: [],
  },
};
test("confirmed fills use observed time, correct market/environment and actual average", () => {
  const result = botOverlays(state, "BTCUSDT", candles, 220000);
  assert.equal(result.markers[0].time, 200);
  assert.match(result.markers[0].text, /fill/i);
  assert.equal(result.lines[0].price, 102);
  assert.equal(botOverlays(state, "SOLUSDT", candles, 220000).markers.length, 0);
  assert.equal(
    botOverlays({ ...state, settings: { environment: "live" } }, "BTCUSDT", candles, 220000).markers.length,
    0,
  );
});
test("legacy entries never invent fill or exit markers; stale state hides actionable lines", () => {
  const legacy = structuredClone(state);
  delete legacy.journal.entries[0].fillObservedAt;
  legacy.journal.entries[0].createdAt = 110000;
  assert.equal(botOverlays(legacy, "BTCUSDT", candles, 220000).markers.length, 0);
  assert.equal(botOverlays({ ...state, stale: true }, "BTCUSDT", candles, 220000).lines.length, 0);
});
test("proposals are distinct, expire, and closed observations never claim exit price", () => {
  const s = structuredClone(state);
  s.journal.entries[0].status = "closed";
  s.journal.entries[0].closedObservedAt = 215000;
  s.journal.proposals = [
    {
      id: "p",
      environment: "demo",
      symbol: "BTCUSDT",
      side: "short",
      createdAt: 210000,
      expiresAt: 250000,
      limit: 103,
      stop: 106,
      target: 95,
    },
  ];
  const result = botOverlays(s, "BTCUSDT", candles, 220000);
  assert.equal(result.markers.length, 3);
  assert.match(result.markers.find((m) => m.id === "a-close").text, /closed/i);
  assert.equal(botOverlays(s, "BTCUSDT", candles, 260000).lines.length, 0);
});

test("events beyond the loaded candle interval are not pinned to an older candle", () => {
  const s = structuredClone(state);
  s.journal.entries[0].fillObservedAt = 500000;
  assert.equal(botOverlays(s, "BTCUSDT", candles, 600000, 100).markers.length, 0);
});
