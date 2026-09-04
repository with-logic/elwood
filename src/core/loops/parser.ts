/**
 * Explicit parser for caller-provided `/loop` command UX.
 * Implements PRD §5.9 and C-LOOP-02/C-LOOP-03.
 */

import type { ElwoodLoopRequest } from "./types.ts";
import { validateLoopRequest } from "./validate.ts";

const intervalFactors = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

type IntervalUnit = keyof typeof intervalFactors;

export function parseLoopCommand(command: string): ElwoodLoopRequest | undefined {
  if (!command.startsWith("/loop")) return undefined;
  const delimiter = command.at(5);
  if (delimiter !== undefined && !/\s/u.test(delimiter)) return undefined;

  const remainder = command.slice(5).replace(/^\s+/u, "");
  if (remainder === "") return validateLoopRequest({ mode: "idle", message: "" });

  const tokenEnd = remainder.search(/\s/u);
  const token = tokenEnd < 0 ? remainder : remainder.slice(0, tokenEnd);
  if (!isPositiveIntervalToken(token)) {
    return validateLoopRequest({ mode: "idle", message: remainder });
  }

  const message = tokenEnd < 0 ? "" : remainder.slice(tokenEnd).replace(/^\s+/u, "");
  const unit = token.at(-1) as IntervalUnit;
  const value = Number(token.slice(0, -1));
  const intervalMs = value * intervalFactors[unit];
  return validateLoopRequest({ mode: "fixed", intervalMs, message });
}

function isPositiveIntervalToken(token: string): boolean {
  if (!/^\d+[smhd]$/u.test(token)) return false;
  return /[1-9]/u.test(token.slice(0, -1));
}
