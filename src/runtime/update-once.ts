/**
 * Once-per-process autoupdate guard shared by adapter preflights.
 * Implements PRD §9.2 fleet-spawn autoupdate dedupe.
 */

const updatedAdapters = new Set<"claude" | "codex">();

/**
 * True exactly once per adapter per process: parents that spawn a roster of
 * sessions at launch should not run N concurrent same-binary updates.
 */
export function shouldRunAutoupdate(adapter: "claude" | "codex"): boolean {
  if (updatedAdapters.has(adapter)) return false;
  updatedAdapters.add(adapter);
  return true;
}

export function resetAutoupdateForTests(): void {
  updatedAdapters.clear();
}
