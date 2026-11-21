/** Resolves a native legacy reset label in the zone reported by Claude (PRD §5.12, C-STATS-05). */

const resetLabel =
  /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (?:(\d{4}), )?(1[0-2]|[1-9])(?::([0-5]\d))?(am|pm) \(([\w/+-]+)\)$/u;
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
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
  const now = Date.now();
  const localNow = new Date(wallTimeAsUtcMs(now));
  const month = months.indexOf(monthText as string);
  const year = yearText === undefined ? yearNearToday(localNow, month) : Number(yearText);
  const day = Number(dayText);
  const hour = (Number(hourText) % 12) + (meridian === "pm" ? 12 : 0);
  const wallTime = Date.UTC(year, month, day, hour, Number(minute));
  if (new Date(wallTime).getUTCDate() !== day) return undefined;

  // Sample both sides of the date to avoid guessing the occurrence of a repeated hour.
  const candidates = new Set(
    [wallTime - dayMs, wallTime + dayMs].map(
      (reference) => wallTime - (wallTimeAsUtcMs(reference) - reference),
    ),
  );
  const matches = [...candidates].filter((instantMs) => wallTimeAsUtcMs(instantMs) === wallTime);
  const [reset] = matches;
  if (reset === undefined || matches.length > 1 || Math.abs(reset - now) > resetVicinityMs)
    return undefined;
  return new Date(reset).toISOString();
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
