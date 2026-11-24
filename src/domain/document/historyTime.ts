const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const RECENT_MS = 120 * MINUTE_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;
const RECENT_DAYS = 7;

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "always" });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const date = new Intl.DateTimeFormat(undefined, { dateStyle: "long" });

function localDay(time: Date) {
  return Date.UTC(time.getFullYear(), time.getMonth(), time.getDate()) / DAY_MS;
}

export function historyTime(createdAtMs: number, now: number) {
  const elapsed = Math.max(0, now - createdAtMs);
  if (elapsed < MINUTE_MS) return relative.format(-Math.floor(elapsed / SECOND_MS), "second");
  if (elapsed < RECENT_MS) return relative.format(-Math.floor(elapsed / MINUTE_MS), "minute");
  const created = new Date(createdAtMs);
  if (!Number.isFinite(created.getTime())) return "Unknown save time";
  const daysAgo = localDay(new Date(now)) - localDay(created);
  if (daysAgo > RECENT_DAYS) return date.format(created);
  const day = daysAgo === 0 ? "Today" : daysAgo === 1 ? "Yesterday" : `Last ${weekday.format(created)}`;
  const hours = created.getHours();
  const minutes = String(created.getMinutes()).padStart(2, "0");
  return `${day} at ${hours % 12 || 12}:${minutes}${hours < 12 ? "am" : "pm"}`;
}
