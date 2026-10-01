/**
 * Shared PTY input submission helpers for adapter sessions.
 * Implements PRD §5.3 prompt and command submission semantics (C-API-31).
 */

import type { ControlSubmitMode } from "../control-queue/index.ts";
import type { ControlSubmitter } from "../control-queue/types.ts";
import { elwoodError } from "../errors.ts";
import {
  holdWhileUnsafe,
  type InputTerminal,
  submissionError,
  throwIfInputAborted,
  waitForInput,
} from "./abort.ts";
import { requestComposerCleanup, stageComposer, submittedComposer } from "./composer-cleanup.ts";
import type { PasteGuard } from "./paste-guard.ts";
import { sanitizePasteText } from "./sanitize.ts";

export { sanitizePasteText } from "./sanitize.ts";

import { preparePasteNudges } from "./paste-nudge.ts";

export type { PasteGuard, RecoveryComposer } from "./paste-guard.ts";

export const commandEnterDelayMs = 150;
export const pasteSettleDelayMs = 150;
export const pasteNudgeDelayMs = 1_000;
export { pasteNudgeAttempts } from "./constants.ts";

/** Explicitly best-effort input for startup/recovery automation. */
export function ignoreInputFailure(input: void | Promise<void>): void {
  void Promise.resolve(input).catch(() => undefined);
}

/**
 * Writes a bracketed paste and submits it.
 *
 * The TUIs ingest bracketed pastes asynchronously; an Enter concatenated into
 * the same PTY write races that ingestion and can be dropped, leaving the prompt
 * staged but never submitted (long personas hit this reliably). The Enter
 * follows after a settle delay; bounded re-Enters require staged content.
 * Native submission activity permanently revokes recovery.
 *
 * While a human or automation-owned dialog is on screen, the WHOLE submission is
 * held: neither the paste nor any Enter reaches the terminal until the dialog
 * clears, so caller/model text can never be interpreted as the dialog's
 * shortcuts or confirm its highlighted option (C-API-37 dialog safety). Paste
 * text is sanitized first so an embedded end sentinel or control byte cannot
 * escape paste mode into live keystrokes (§5.3).
 *
 * Ordinary sends resolve and release composer ownership after the first physical
 * Enter; recovery continues in the background. Awaited ergonomic input keeps the queue and
 * composer owned until fresh rendered input is positively empty. Its physical
 * submission callback still runs after the first Enter, before native acceptance.
 * Native activity stops retry Enters without accepting an awaited draft; raw input
 * revokes recovery and cleanup authority over the caller's replacement draft.
 */
async function writePastedPrompt(
  terminal: InputTerminal,
  prompt: string,
  awaitInputConsumption: boolean,
  guard?: PasteGuard,
  signal?: AbortSignal,
  settleDelayMs = pasteSettleDelayMs,
  nudgeDelayMs = pasteNudgeDelayMs,
  onSubmitted?: () => void,
  beforeEnter?: (payload: string) => void,
): Promise<void> {
  // Hold paste and Enter until observed dialog clearance (C-API-37).
  if (terminal.settled || guard?.blocked?.()) await holdWhileUnsafe(terminal, guard, signal);
  throwIfInputAborted(signal);
  // Keep caller text inside bracketed paste, including embedded end sentinels (§5.3).
  const payload = sanitizePasteText(prompt);
  const recovery = guard?.captureRecovery?.();
  const priorEmptyFrame = guard?.emptyFrame?.();
  const rawInputSignal = stageComposer(terminal);
  const nudgeSignal =
    rawInputSignal && signal
      ? AbortSignal.any([rawInputSignal, signal])
      : (rawInputSignal ?? signal);
  const nudges = preparePasteNudges(
    terminal,
    guard,
    payload,
    nudgeSignal,
    nudgeDelayMs,
    priorEmptyFrame,
    recovery?.revoked,
  );
  await terminal.sendInput(`\u001b[200~${payload}\u001b[201~`);
  try {
    await waitForInput(settleDelayMs, signal);
    // Hold the submitting Enter while a blocking dialog is on screen: firing it
    // would confirm the dialog's highlighted option instead of submitting the
    // staged paste (C-API-37 dialog safety). The paste stays staged behind the
    // dialog and submits once it clears.
    await holdWhileUnsafe(terminal, guard, signal);
    throwIfInputAborted(signal);
    nudges?.beforeEnter();
    guard?.beforeEnter?.();
    beforeEnter?.(payload);
    await terminal.sendInput("\r");
    // Physical submission is observable in both modes; only ordinary sends release here.
    if (!awaitInputConsumption) submittedComposer(terminal);
    onSubmitted?.();
    if (awaitInputConsumption) {
      if (!(await nudges?.awaitEmptyInput()))
        throw elwoodError("wait_timeout", "Turn input remained staged after submission attempts.");
      throwIfInputAborted(nudgeSignal);
    }
    // The awaited queue operation and composer share the verified input-consumption boundary.
    if (awaitInputConsumption) submittedComposer(terminal);
    else nudges?.start();
  } catch (error) {
    if (awaitInputConsumption || signal?.aborted)
      await requestComposerCleanup(terminal, guard?.blocked);
    throw awaitInputConsumption ? submissionError(error) : error;
  }
}

export async function writeQueuedInput(
  terminal: InputTerminal,
  input: string,
  mode: ControlSubmitMode,
  guard?: PasteGuard,
  signal?: AbortSignal,
  enterDelayMs = commandEnterDelayMs,
  onSubmitted?: () => void,
  beforeEnter?: (payload: string) => void,
): Promise<void> {
  // Dispatch through a Record keyed by ControlSubmitMode: a new mode must add an
  // entry here or the object fails to type-check, so it can never silently reuse
  // pasted-input behavior. The map has no unreachable default arm, so 100%
  // coverage holds (all entries are exercised).
  const submitters: Readonly<Record<ControlSubmitMode, () => Promise<void>>> = {
    // Resolve only after the input's submitting Enter has dispatched, so the next
    // queued operation cannot write into the composer first (FIFO).
    pasted_input: () =>
      writePastedPrompt(
        terminal,
        input,
        false,
        guard,
        signal,
        undefined,
        undefined,
        onSubmitted,
        beforeEnter,
      ),
    awaited_input: () =>
      writePastedPrompt(
        terminal,
        input,
        true,
        guard,
        signal,
        undefined,
        undefined,
        onSubmitted,
        beforeEnter,
      ),
    // Slash-command popups (Codex) swallow an Enter that arrives in the same PTY
    // chunk as the command text, so Enter follows as a separate keystroke. The
    // returned promise resolves only after that Enter is dispatched, so a queued
    // command's Enter always lands before the next operation writes.
    command: async () => {
      if (terminal.settled || guard?.blocked?.()) await holdWhileUnsafe(terminal, guard, signal);
      throwIfInputAborted(signal);
      stageComposer(terminal);
      await terminal.sendInput(input);
      try {
        await waitForInput(enterDelayMs, signal);
        await holdWhileUnsafe(terminal, guard, signal);
        throwIfInputAborted(signal);
        await terminal.sendInput("\r");
        submittedComposer(terminal);
      } catch (error) {
        if (signal?.aborted) await requestComposerCleanup(terminal, guard?.blocked);
        throw error;
      }
    },
  };
  await submitters[mode]();
}

/** Bind the session terminal while preserving physical-submission evidence (C-ATTN-02). */
export function queuedInputSubmitter(terminal: InputTerminal, guard: PasteGuard): ControlSubmitter {
  return (input, mode, signal, onSubmitted, beforeEnter) =>
    writeQueuedInput(
      terminal,
      input,
      mode,
      guard,
      signal,
      commandEnterDelayMs,
      onSubmitted,
      beforeEnter,
    );
}
