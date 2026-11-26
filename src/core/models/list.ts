/**
 * Session-less model enumeration: start a throwaway session, list its models,
 * and always tear it down. Implements PRD §5.3 and C-API-41.
 */

import type { ElwoodAgentSession } from "../agent-session.ts";
import { errnoCode, toError } from "../errors.ts";
import type { AgentModelOption } from "./rows.ts";

/** Launch-relevant options for a throwaway model-listing probe (C-API-41). */
export type ListModelsOptions = {
  readonly cwd: string;
  readonly stateDir?: string;
  readonly autoupdate?: boolean;
  readonly hookTimeoutMs?: number;
  readonly strictVersionCheck?: boolean;
  /** Bounds the picker automation, exactly as on a live session's `listModels`. */
  readonly timeoutMs?: number;
};

/**
 * The throwaway session surface a probe drives: wait for ready, list, tear down.
 * Derived from the public session contract so it uses the SAME closed
 * `ElwoodSessionStatus` type and cannot drift from the real methods.
 */
type ProbeSession<T extends AgentModelOption = AgentModelOption> = Pick<
  ElwoodAgentSession,
  "waitForStatus" | "teardown"
> & {
  listModels(options?: { readonly timeoutMs?: number }): Promise<readonly T[]>;
};

/** Adapter hooks for a probe: how to start the session and how to remove ALL its state. */
export type ProbeAdapter<T extends AgentModelOption> = {
  /**
   * Starts the throwaway session against the probe's owned state directory. `refuse`
   * ends the probe with that error as soon as the adapter calls it, even before
   * readiness, for a prompt the probe must not answer (§5.3).
   */
  readonly start: (refuse: (error: Error) => void) => Promise<ProbeSession<T>>;
  /**
   * Removes ALL probe state (its owned temp directory and everything under it).
   * Runs on EVERY outcome — success, readiness/picker failure, AND a start failure
   * that already allocated a state directory or runtime files — so nothing leaks
   * regardless of how far startup got (C-API-41). Best-effort and non-throwing.
   */
  readonly removeState: () => void;
};

/**
 * Runs a throwaway session to its first readiness, lists its models, and cleans
 * up EVERYTHING it allocated — the session (via `teardown`) and its owned state
 * directory (via `removeState`) — on every outcome, so nothing is leaked (C-API-41).
 * The probe only opens and cancels the picker, so the user's default stays
 * untouched. A teardown/cleanup failure never masks a real list/readiness error.
 */
export async function probeModels<T extends AgentModelOption>(
  adapter: ProbeAdapter<T>,
  options: ListModelsOptions,
): Promise<readonly T[]> {
  const refusal = probeRefusal();
  let session: ProbeSession<T>;
  try {
    session = await adapter.start(refusal.refuse);
  } catch (error) {
    // Adapter startup can allocate a state directory / runtime files BEFORE the
    // bridge or PTY fails, so "no returned session" does not mean "nothing
    // allocated": remove the owned state directory before rethrowing (C-API-41).
    adapter.removeState();
    throw error;
  }
  try {
    return await runProbe(session, options, refusal.refused);
  } finally {
    // Always sweep the owned state directory, even after a successful teardown.
    adapter.removeState();
  }
}

async function runProbe<T extends AgentModelOption>(
  session: ProbeSession<T>,
  options: ListModelsOptions,
  refused: Promise<never>,
): Promise<readonly T[]> {
  let models: readonly T[];
  try {
    // The race observes the loser's later settlement, so neither can go unhandled.
    await Promise.race([session.waitForStatus((status) => status === "ready"), refused]);
    models = await session.listModels(
      options.timeoutMs === undefined ? undefined : { timeoutMs: options.timeoutMs },
    );
  } catch (error) {
    // The list/readiness error is what the caller must see, so it stays the thrown
    // error and teardown never masks it. But a FAILED teardown here can leak a
    // probe process tree, so surface it as a bounded `cause` rather than silently
    // discarding it: the caller keeps the primary error AND learns of the leak.
    await teardownWithoutMasking(session, toError(error));
    throw error;
  }
  // The clean path DOES surface a genuine teardown failure — a leaked probe
  // session is a real defect the caller should learn about (C-API-41).
  await session.teardown();
  return models;
}

/** A rejection the adapter can trigger before anything is awaiting it. */
function probeRefusal(): {
  readonly refuse: (error: Error) => void;
  readonly refused: Promise<never>;
} {
  const { promise, reject } = Promise.withResolvers<never>();
  // Handled here so a refusal during start is not an unhandled rejection; the race rethrows it.
  promise.catch(() => undefined);
  return { refuse: reject, refused: promise };
}

/**
 * Tear down the probe on the error path without masking the primary error. A
 * rejecting teardown can leave a probe process tree alive, so instead of
 * discarding it we attach a bounded diagnostic (the teardown error's allowlisted
 * errno, or its name) to the primary error's `cause` — visible to the caller,
 * never overriding the readiness/picker error that actually explains the failure.
 */
async function teardownWithoutMasking(session: ProbeSession, primary: Error): Promise<void> {
  try {
    await session.teardown();
  } catch (teardownError) {
    // `cause` may already be set by the primary error; only fill it when empty so
    // we never clobber a more specific upstream cause. The token is bounded — an
    // errno like `EPERM` or the error's constructor name — never a raw message.
    if (primary.cause === undefined) {
      const token = errnoCode(teardownError) ?? toError(teardownError).name;
      primary.cause = `probe_teardown_failed:${token}`;
    }
  }
}
