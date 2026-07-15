/**
 * Session-less model enumeration: start a throwaway session, list its models,
 * and always tear it down. Implements PRD §5.3 and C-API-41.
 */

import type { ElwoodAgentSession } from "./agent-session.ts";
import type { AgentModelOption } from "./model-rows.ts";

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
type ProbeSession = Pick<ElwoodAgentSession, "waitForStatus" | "listModels" | "teardown">;

/** Adapter hooks for a probe: how to start the session and how to remove ALL its state. */
export type ProbeAdapter<S extends ProbeSession> = {
  /** Starts the throwaway session against the probe's owned state directory. */
  readonly start: () => Promise<S>;
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
export async function probeModels<S extends ProbeSession>(
  adapter: ProbeAdapter<S>,
  options: ListModelsOptions,
): Promise<readonly AgentModelOption[]> {
  let session: S;
  try {
    session = await adapter.start();
  } catch (error) {
    // Adapter startup can allocate a state directory / runtime files BEFORE the
    // bridge or PTY fails, so "no returned session" does not mean "nothing
    // allocated": remove the owned state directory before rethrowing (C-API-41).
    adapter.removeState();
    throw error;
  }
  try {
    return await runProbe(session, options);
  } finally {
    // Always sweep the owned state directory, even after a successful teardown.
    adapter.removeState();
  }
}

async function runProbe<S extends ProbeSession>(
  session: S,
  options: ListModelsOptions,
): Promise<readonly AgentModelOption[]> {
  let models: readonly AgentModelOption[];
  try {
    await session.waitForStatus((status) => status === "ready");
    models = await session.listModels(
      options.timeoutMs === undefined ? undefined : { timeoutMs: options.timeoutMs },
    );
  } catch (error) {
    // The list/readiness error is what the caller must see; teardown is
    // best-effort here so its own failure cannot mask the real one.
    await session.teardown().catch(() => undefined);
    throw error;
  }
  // The clean path DOES surface a genuine teardown failure — a leaked probe
  // session is a real defect the caller should learn about (C-API-41).
  await session.teardown();
  return models;
}
