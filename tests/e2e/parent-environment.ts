/** Adapter-neutral parent-process isolation assertion for native proofs (PRD §12). */

/** Compare the environment without exposing variable names or values on failure. */
export function assertParentEnvironmentUnchanged(
  before: Readonly<Record<string, string | undefined>>,
  after: Readonly<Record<string, string | undefined>>,
): void {
  const keys = Object.keys(before);
  const unchanged =
    keys.length === Object.keys(after).length &&
    keys.every((key) => Object.hasOwn(after, key) && before[key] === after[key]);
  if (!unchanged) throw new Error("Parent environment changed.");
}
