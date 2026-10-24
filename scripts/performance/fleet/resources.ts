/** Checks benchmark resource counts without hiding extra handles of baseline types (PRD §9.4). */
export function additionalResources(before: readonly string[], after: readonly string[]): string[] {
  const available = new Map<string, number>();
  for (const name of before) available.set(name, (available.get(name) ?? 0) + 1);
  return after.filter((name) => {
    const remaining = available.get(name) ?? 0;
    available.set(name, remaining - 1);
    return remaining <= 0;
  });
}
