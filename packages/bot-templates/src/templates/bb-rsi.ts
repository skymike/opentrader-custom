import type { BotTemplate, IBotConfiguration } from "@opentrader/bot-processor";
import { z } from "zod";
import { backtestBbRsi } from "./bb-rsi-model.js";

const schema = z.object({ startingEquity: z.number().finite().positive().default(10_000) });

export const bbRsi: BotTemplate<IBotConfiguration> = function* bbRsi(ctx) {
  if (ctx.onStart) throw new Error("BB/RSI order execution is disabled until Bitget demo protection is verified");
};

bbRsi.displayName = "Bollinger Bands / RSI";
bbRsi.schema = schema;
bbRsi.timeframe = "1h";
bbRsi.requiredHistory = 200;
bbRsi.runPolicy = { onCandleClosed: true };
bbRsi.watchers = { watchCandles: ({ symbol }) => symbol };
bbRsi.backtest = (candles, config) => {
  if (config.timeframe !== "1h") throw new Error("BB/RSI requires the 1h timeframe");
  const { startingEquity } = schema.strict().parse(config.settings);
  return JSON.stringify(backtestBbRsi(candles, startingEquity), null, 2);
};
