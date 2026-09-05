/**
 * Deterministic CLI duration parsing shared by config and request resolution.
 * Implements PRD §12A.2/§12A.4 and C-CLI-07/C-CLI-14.
 */

import { CliValidationError } from "./types.ts";

const durationPattern = /^([1-9]\d*)(ms|s|m|h)$/u;
const multipliers = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;

export function parseDuration(
  value: string,
  code: "invalid_arguments" | "invalid_config" = "invalid_arguments",
): number {
  const match = durationPattern.exec(value);
  if (!match)
    throw new CliValidationError(code, "Duration must be a positive integer plus ms, s, m, or h.");
  const amount = Number(match[1]);
  const unit = match[2] as keyof typeof multipliers;
  const milliseconds = amount * multipliers[unit];
  if (!Number.isSafeInteger(milliseconds)) {
    throw new CliValidationError(code, "Duration is larger than the supported safe integer range.");
  }
  return milliseconds;
}
