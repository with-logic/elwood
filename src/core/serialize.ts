/**
 * The shared tool-input/output serializer used across activity projection.
 * Implements the PRD's single serialization rule (§5.4) so Claude transcript
 * summaries and Codex activity metadata cannot diverge in how they stringify a
 * tool's structured input/output.
 */

/** Serializes a value to a string, or undefined for null/undefined; never throws. */
export function stringify(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
