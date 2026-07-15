/**
 * Session-less model enumeration: start a throwaway session, list its models,
 * and always tear it down. Implements PRD §5.3 and C-API-41.
 */

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

/** The throwaway session surface a probe drives: wait for ready, list, tear down. */
type ProbeSession = {
  readonly status: string;
  waitForStatus(match: (status: string) => boolean, timeoutMs?: number): Promise<unknown>;
  listModels(options?: { readonly timeoutMs?: number }): Promise<readonly AgentModelOption[]>;
  teardown(): Promise<void>;
};

/**
 * Runs a throwaway session to its first readiness, lists its models, and ALWAYS
 * tears it down — on success, on a readiness/picker failure, and (via the caller's
 * `start` rejecting) on a start failure — so nothing is leaked (C-API-41). The
 * probe only opens and cancels the picker, so the user's default and config stay
 * untouched. A teardown failure never masks a real list/readiness error.
 */
export async function probeModels<S extends ProbeSession>(
  start: () => Promise<S>,
  options: ListModelsOptions,
): Promise<readonly AgentModelOption[]> {
  // A start failure rejects here BEFORE any session exists, so there is nothing
  // to tear down: the adapter's own start error surfaces to the caller as-is.
  const session = await start();
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
