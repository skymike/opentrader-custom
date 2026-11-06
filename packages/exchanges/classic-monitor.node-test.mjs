import assert from "node:assert/strict";
import { test } from "node:test";
import { readClassic, summarizeCandles } from "./classic-monitor.mjs";

test("monitor refuses order endpoints before signing or sending", async () => {
  await assert.rejects(readClassic({
    sign() { throw new Error("must not sign"); },
    request() { throw new Error("must not send"); },
  }, "v2/mix/order/place-order"), /Unsupported account read/);
});

test("Classic account requests use GET and the real account host", async () => {
  const exchange = {
    sign(endpoint, api, method) {
      assert.equal(method, "GET");
      assert.deepEqual(api, ["private", "mix"]);
      return { url: "https://api.bitget.com/api/" + endpoint, method };
    },
    async request(endpoint, api, method) {
      assert.equal(method, "GET");
      return { code: "00000", data: [{ marginCoin: "USDT", available: "10" }] };
    },
  };
  assert.equal((await readClassic(exchange, "v2/mix/account/accounts"))[0].available, "10");
  exchange.sign = () => ({ url: "https://example.com/", method: "GET" });
  await assert.rejects(readClassic(exchange, "v2/mix/account/accounts"), /Unexpected account routing/);
});

test("indicator calculation excludes the open candle and rejects gaps", () => {
  const hour = 3_600_000;
  const rows = Array.from({ length: 22 }, (_, i) => [i * hour, 100, 100, 100, i === 21 ? 999 : 100, 1]);
  const result = summarizeCandles(rows, 21 * hour + 100);
  assert.equal(result.rsi, 50);
  assert.equal(result.close, 100);
  assert.equal(result.lower, 100);
  assert.equal(result.upper, 100);
  assert.throws(() => summarizeCandles(rows.slice(0, 20), 21 * hour), /Incomplete/);
  rows[10][0] += hour;
  assert.throws(() => summarizeCandles(rows, 21 * hour), /Incomplete/);
});
