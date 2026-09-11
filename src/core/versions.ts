/**
 * Dotted-version parsing and comparison shared by both adapters' preflight
 * checks. Implements PRD §9.2: `parseVersion` extracts the first
 * `major.minor.patch` triple from a `--version` probe and `compareVersions`
 * orders two such triples numerically (a missing or non-numeric part counts as 0,
 * so a malformed component can never produce a NaN comparison).
 */

export function parseVersion(output: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null;
}

/** Negative when `left` < `right`, positive when greater, 0 when equal. */
export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(toVersionPart);
  const b = right.split(".").map(toVersionPart);
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function toVersionPart(part: string): number {
  const parsed = Number.parseInt(part, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
