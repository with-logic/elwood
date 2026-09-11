/**
 * Per-adapter reasoning-effort enums and a shared before-spawn validator.
 * Implements PRD §5.1/§5.2 (C-CLAUDE-20) and §5.5/§5.6 (C-CODEX-21).
 *
 * The two CLIs accept DIFFERENT effort sets (Codex adds `none`/`minimal`; both
 * share `low`..`max`), and both are version-coupled to the installed CLI, so the
 * value is a fixed per-adapter allowlist rather than a shared Elwood enum. Elwood
 * validates BEFORE spawning: Claude's `--effort` would reject inconsistently and
 * Codex validates server-side (a bad value launches, then fails at the first turn
 * with a provider 400), so a start-time check turns both into one fast, clear error.
 */

import type { ClaudeEffortLevel } from "../claude/hooks/names.ts";
import { type ElwoodErrorName, elwoodError } from "./errors.ts";

/**
 * Claude's `--effort` levels (claude 2.1.245: `low, medium, high, xhigh, max`).
 * `ClaudeReasoningEffort` is the SAME set Claude already reports in hook payloads
 * (`ClaudeEffortLevel`), aliased so the launch option and the hook input never
 * drift. The coupling is enforced at COMPILE time in both directions with no
 * runtime statement: `satisfies` rejects a tuple member outside the union, and
 * `Covers` (whose constraint requires every union member to be in the tuple)
 * rejects a union member the tuple omits.
 */
export type ClaudeReasoningEffort = ClaudeEffortLevel;
export const claudeReasoningEfforts = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ClaudeReasoningEffort[];
/** `T` itself, instantiable only when `U` (the union) is covered by `T`'s members. */
type Covers<T extends readonly string[], U extends T[number]> = readonly U[] extends T ? never : T;
/** The launch tuple, proven to cover the hook-payload union (fails to compile on drift). */
export type ClaudeReasoningEfforts = Covers<typeof claudeReasoningEfforts, ClaudeReasoningEffort>;

/** Codex `model_reasoning_effort` values (codex 0.149.1, API-enforced enum). */
export const codexReasoningEfforts = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type CodexReasoningEffort = (typeof codexReasoningEfforts)[number];

/**
 * Narrows a caller-supplied `reasoningEffort` to the adapter's enum, throwing the
 * typed `*_invalid_reasoning_effort` error (listing the valid values) when it is out
 * of range. `undefined` passes through unchanged — the option is absent, not invalid.
 * Returning the narrowed literal lets callers forward it without a second cast.
 */
export function validateReasoningEffort<T extends string>(
  value: T | undefined,
  valid: readonly T[],
  errorCode: ElwoodErrorName,
): T | undefined {
  if (value === undefined || valid.includes(value)) return value;
  throw elwoodError(errorCode, `Invalid reasoningEffort ${JSON.stringify(value)}.`, {
    reasoningEffort: value,
    valid,
  });
}
