/** Validate bounded workspace answer options (PRD §5.13). */
import { elwoodError } from "../../errors.ts";
import { isRecord } from "../../predicates.ts";
import { deadlineClock, scheduleDeadline } from "../../timers.ts";
import type { ElwoodDialogAnswerOptions } from "../types.ts";

export function answerOptions(options: ElwoodDialogAnswerOptions | undefined) {
  try {
    if (options !== undefined && !isRecord(options)) throw new Error("invalid options");
    const providedTimeout = options?.timeoutMs;
    const timeoutMs = providedTimeout === undefined ? 12_000 : providedTimeout;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("invalid timeout");
    const signal = options?.signal;
    return { timeoutMs, signal: AbortSignal.any(signal === undefined ? [] : [signal]) };
  } catch {
    throw elwoodError("invalid_dialog_answer", "The native dialog answer options are invalid.");
  }
}

export function scheduleInputGrace(
  earliestInputAtMs: number | undefined,
  now: number,
  advance: () => void,
): (() => void) | undefined {
  if (earliestInputAtMs === undefined || earliestInputAtMs <= now) return undefined;
  return scheduleDeadline(
    { deadlineAtMs: earliestInputAtMs, initialDelayMs: Math.ceil(earliestInputAtMs - now) },
    advance,
    deadlineClock,
  );
}
