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

export function preparePasteNudges(
  terminal: InputTerminal,
  guard: PasteGuard | undefined,
  payload: string,
  signal: AbortSignal | undefined,
  delayMs: number,
  priorEmptyFrame: ReturnType<EmptyComposerObserver>,
  revoked?: () => boolean,
) {
  if (!guard) return undefined;
  const staged =
    "prepareStaged" in guard
      ? guard.prepareStaged(payload)
      : () => guard.staged(guard.snapshot(), payload);
  let retryAt = 0;
  let hasFreshFrame: (() => boolean) | undefined;
  const beforeEnter = () => {
    hasFreshFrame = guard.captureRenderProgress?.();
    retryAt = Date.now() + delayMs;
  };
  const hasRenderedAfterEnter = (requireProof: boolean) => hasFreshFrame?.() ?? !requireProof;
  let attempts = 0;
  let observations = 0;
  const retry = async (awaitInputConsumption: boolean): Promise<Observation> => {
    if (awaitInputConsumption && Date.now() < retryAt) return "paced";
    if (attempts === pasteNudgeAttempts) return "exhausted";
    attempts += 1;
    beforeEnter();
    await tryRecoveryEnter(terminal);
    return "pending";
  };
  const observe = async (awaitInputConsumption: boolean): Promise<Observation> => {
    const unsafe = await writeUnsafe(terminal, guard, signal, awaitInputConsumption);
    if (signal?.aborted) return "cancelled";
    // Hook evidence stops retries, but cannot itself release an awaited image draft.
    const recoveryRevoked = revoked?.();
    if (!awaitInputConsumption && recoveryRevoked) return "revoked";
    if (unsafe) return "pending";
    const fresh = hasRenderedAfterEnter(awaitInputConsumption);
    const empty = guard.emptyFrame?.();
    // A geometry-only token change cannot replace post-Enter rendered output.
    if (fresh && empty && empty !== priorEmptyFrame) return "accepted";
    if (recoveryRevoked) return "revoked";
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
  return { beforeEnter, start: schedule, awaitEmptyInput };
}

async function tryRecoveryEnter(terminal: InputTerminal): Promise<void> {
  try {
    await terminal.sendInput("\r");
  } catch {
    // Recovery is best-effort after the initial Enter has dispatched.
  }
}
