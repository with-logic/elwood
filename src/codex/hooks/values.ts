/** Shared Codex nullable text validation at ingress and response boundaries (PRD §7A.2). */

export function optionalNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}
