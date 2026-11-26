/** Shared native observation/retry engine with background or awaited ownership (PRD §5.3). */
import { type InputTerminal, throwIfInputAborted, writeUnsafe } from "./abort.ts";
import type { EmptyComposerObserver } from "./clear-ack.ts";
import { pasteNudgeAttempts, pasteObservationLimit } from "./constants.ts";
import type { PasteGuard } from "./index.ts";
import { RenderWakeup } from "./render-wakeup.ts";

type Observation =
  | "pending"
  | "accepted"
  | "exhausted"
  | "revoked"
  | "cancelled"
  | "legacy_done"
  | "paced";

/** The render probe captured just before the latest Enter, initial or recovery. */
type EnterRender = { probe?: (() => boolean) | undefined };

/**
 * Checks that a fresh frame after the latest Enter shows empty input other than the frame
 * from before the paste. Cleanup keeps the entered check as long as its draft, so these
 * closures are built here, apart from the payload that a staged predicate may hold.
 */
function consumptionChecks(
  guard: PasteGuard,
  enter: EnterRender,
  priorEmptyFrame: ReturnType<EmptyComposerObserver>,
) {
  const rendered = (requireProof: boolean) => enter.probe?.() ?? !requireProof;
  const consumed = (requireProof: boolean): boolean => {
    const empty = guard.emptyFrame?.();
    return rendered(requireProof) && !!empty && empty !== priorEmptyFrame;
  };
  /** Requires render proof, so input whose Enter was never captured is never consumed. */
  const entered = () => consumed(true);
  return { rendered, consumed, entered };
}

export function preparePasteNudges(
  terminal: InputTerminal,
  guard: PasteGuard | undefined,
  payload: string,
  signal: AbortSignal | undefined,
  delayMs: number,
  priorEmptyFrame: ReturnType<EmptyComposerObserver>,
  revoked?: () => boolean,
  writeEnter = () => terminal.sendInput("\r"),
) {
  if (!guard) return undefined;
  const staged =
    "prepareStaged" in guard
      ? guard.prepareStaged(payload)
      : () => guard.staged(guard.snapshot(), payload);
  let retryAt = 0;
  const enter: EnterRender = {};
  const checks = consumptionChecks(guard, enter, priorEmptyFrame);
  const beforeEnter = () => {
    enter.probe = guard.captureRenderProgress?.();
    retryAt = Date.now() + delayMs;
  };
  let attempts = 0;
  let observations = 0;
  const retry = async (awaitInputConsumption: boolean): Promise<Observation> => {
    if (awaitInputConsumption && Date.now() < retryAt) return "paced";
    if (attempts === pasteNudgeAttempts) return "exhausted";
    attempts += 1;
    beforeEnter();
    await tryRecoveryEnter(writeEnter);
    return "pending";
  };
  const observe = async (awaitInputConsumption: boolean): Promise<Observation> => {
    const unsafe = await writeUnsafe(terminal, guard, signal, awaitInputConsumption);
    if (signal?.aborted) return "cancelled";
    // Hook evidence stops retries, but cannot itself release an awaited image draft.
    const recoveryRevoked = revoked?.();
    if (!awaitInputConsumption && recoveryRevoked) return "revoked";
    if (unsafe) return "pending";
    // A geometry-only token change cannot replace post-Enter rendered output.
    if (checks.consumed(awaitInputConsumption)) return "accepted";
    if (recoveryRevoked) return "revoked";
    const fresh = checks.rendered(awaitInputConsumption);
    if (!(fresh && staged())) return guard.emptyFrame ? "pending" : "legacy_done";
    return retry(awaitInputConsumption);
  };
  const schedule = () => {
    const timer = setTimeout(nudge, delayMs);
    timer.unref?.();
  };
  const nudge = async () => {
    const result = await observe(false);
    observations += 1;
    if (
      result === "pending" &&
      attempts < pasteNudgeAttempts &&
      observations < pasteObservationLimit
    )
      schedule();
  };
  const awaitEmptyInput = async (): Promise<boolean> => {
    const wakeup = new RenderWakeup(guard.subscribeRender);
    try {
      for (;;) {
        wakeup.consume();
        const result = await observe(true);
        throwIfInputAborted(signal);
        if (result === "accepted") return true;
        if (result === "exhausted") return false;
        await wakeup.wait(signal, result === "paced" ? retryAt - Date.now() : undefined);
      }
    } finally {
      wakeup.dispose();
    }
  };
  // Cleanup reads the same evidence after the wait ends.
  return { beforeEnter, start: schedule, awaitEmptyInput, enteredInputConsumed: checks.entered };
}

async function tryRecoveryEnter(writeEnter: () => void | Promise<void>): Promise<void> {
  try {
    await writeEnter();
  } catch {
    // Recovery is best-effort after the initial Enter has dispatched.
  }
}
