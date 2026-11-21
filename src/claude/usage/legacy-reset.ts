/** Resolves a native legacy reset label in the zone reported by Claude (PRD §5.12, C-STATS-05). */

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const resetLabel = new RegExp(
  String.raw`^(${months.join("|")}) (\d{1,2}), (?:(\d{4}), )?(1[0-2]|[1-9])(?::([0-5]\d))?(am|pm) \(([\w/+-]+)\)$`,
  "u",
);
const dayMs = 24 * 60 * 60_000;
// A legacy label describes a session or weekly reset. Allow a day of slack around a week.
const resetVicinityMs = 8 * dayMs;

type WallTimeProjection = (instantMs: number) => number;

export function createLegacyResetReader(): (label: string | undefined) => string | undefined {
  const projections = new Map<string, WallTimeProjection | undefined>();
  return (label) => legacyReset(label, projections);
}

function legacyReset(
  label: string | undefined,
  projections: Map<string, WallTimeProjection | undefined>,
): string | undefined {
  if (label === undefined) return undefined;
  const match = resetLabel.exec(label);
  if (!match) return undefined;
  const [, monthText, dayText, yearText, hourText, minute = "0", meridian, zone] = match;
  const timeZone = zone as string;
  if (!projections.has(timeZone)) projections.set(timeZone, createWallTimeProjection(timeZone));
  const wallTimeAsUtcMs = projections.get(timeZone);
  if (!wallTimeAsUtcMs) return undefined;
  const nowMs = Date.now();
  const localNow = new Date(wallTimeAsUtcMs(nowMs));
  const month = months.indexOf(monthText as string);
  const year = yearText === undefined ? yearNearToday(localNow, month) : Number(yearText);
  const day = Number(dayText);
  const hour = (Number(hourText) % 12) + (meridian === "pm" ? 12 : 0);
  const wallTimeMs = Date.UTC(year, month, day, hour, Number(minute));
  if (new Date(wallTimeMs).getUTCDate() !== day) return undefined;

  // Sample both sides of the date to avoid guessing the occurrence of a repeated hour.
  const candidates = new Set(
    [wallTimeMs - dayMs, wallTimeMs + dayMs].map(
      (referenceMs) => wallTimeMs - (wallTimeAsUtcMs(referenceMs) - referenceMs),
    ),
  );
  const matches = [...candidates].filter((instantMs) => wallTimeAsUtcMs(instantMs) === wallTimeMs);
  const [resetMs] = matches;
  const hasUniqueReset = resetMs !== undefined && matches.length === 1;
  if (!hasUniqueReset) return undefined;
  const isWithinResetVicinity = Math.abs(resetMs - nowMs) <= resetVicinityMs;
  return isWithinResetVicinity ? new Date(resetMs).toISOString() : undefined;
}

function yearNearToday(today: Date, month: number): number {
  const currentMonth = today.getUTCMonth();
  const year = today.getUTCFullYear();
  // A report can cross either side of New Year, including one just-expired meter.
  if (month === 0 && currentMonth === 11) return year + 1;
  if (month === 11 && currentMonth === 0) return year - 1;
  return year;
}

function createWallTimeProjection(zone: string): WallTimeProjection | undefined {
  try {
    // This ISO-ordered locale gives the calendar values in the reported zone, without an offset.
    const format = new Intl.DateTimeFormat("sv-SE", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    return (instantMs) => Date.parse(`${format.format(instantMs).replace(" ", "T")}:00Z`);
  } catch {
    return undefined;
  }
}
