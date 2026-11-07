const positive = (value) => Number.isFinite(value) && value > 0;
export function botOverlays(
  state,
  symbol,
  candles,
  now = Date.now(),
  intervalSeconds = candles.length > 1 ? candles[1].time - candles[0].time : 3600,
) {
  const markers = [],
    lines = [],
    details = {};
  if (!state || !candles.length) return { markers, lines, details };
  const environment = state.settings.environment;
  const timeFor = (stamp) => {
    if (!positive(stamp)) return null;
    const seconds = Math.floor(stamp / 1000);
    if (seconds < candles[0].time || seconds > now / 1000 + 5 || seconds >= candles.at(-1).time + intervalSeconds)
      return null;
    return candles.findLast((c) => c.time <= seconds)?.time ?? null;
  };
  const match = (e) => e.environment === environment && e.symbol === symbol;
  const add = (entry, stamp, label, color, shape, suffix) => {
    const time = timeFor(stamp);
    if (time === null) return;
    const id = entry.id + suffix;
    markers.push({ id, time, position: entry.side === "long" ? "belowBar" : "aboveBar", shape, color, text: label });
    details[id] = { ...entry, event: label, observedAt: stamp };
  };
  const levels = (entry, pending) => {
    for (const [key, title, color] of [
      [pending ? "limit" : "fillPrice", pending ? "Proposed limit" : "Entry avg", "#6aa5ff"],
      ["stop", "SL", "#f16b7a"],
      ["target", "TP", "#22b997"],
    ])
      if (positive(entry[key]))
        lines.push({
          price: entry[key],
          color,
          lineWidth: 1,
          lineStyle: pending ? 2 : 0,
          axisLabelVisible: true,
          title: `${environment.toUpperCase()} ${title}${!pending && key !== "fillPrice" ? (entry.protected ? " · last check OK" : " · unverified") : ""}`,
        });
  };
  for (const entry of (state.journal.entries ?? []).filter(match)) {
    if (positive(entry.filled))
      add(
        entry,
        entry.fillObservedAt,
        `${environment.toUpperCase()} ${entry.side === "long" ? "BUY" : "SELL"} fill`,
        entry.side === "long" ? "#22b997" : "#f16b7a",
        entry.side === "long" ? "arrowUp" : "arrowDown",
        "-fill",
      );
    if (entry.status === "closed")
      add(entry, entry.closedObservedAt, `${environment.toUpperCase()} closed`, "#aebdd0", "circle", "-close");
    if (!state.stale && !["closed", "unfilled", "rejected"].includes(entry.status)) levels(entry, false);
  }
  if (!state.stale)
    for (const entry of (state.journal.proposals ?? []).filter(match).filter((e) => e.expiresAt > now)) {
      add(entry, entry.createdAt, `${environment.toUpperCase()} proposal`, "#e9b85b", "square", "-proposal");
      levels(entry, true);
    }
  markers.sort((a, b) => a.time - b.time);
  return { markers, lines, details };
}
