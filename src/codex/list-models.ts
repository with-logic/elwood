/**
 * Session-less Codex model enumeration. Implements PRD §5.3 and C-API-41.
 */

import { type ListModelsOptions, probeModels } from "../core/list-models.ts";
import type { AgentModelOption } from "../core/model-rows.ts";
import { startCodex } from "./session.ts";

/**
 * Lists the models available to Codex WITHOUT a caller-held session: starts a
 * throwaway session (autotrust implied so a trust prompt cannot stall the probe),
 * lists its models, and always tears it down (C-API-41). The probe runs read-only
 * with approvals off, and the picker is opened and cancelled only, so the user's
 * saved MODEL default stays untouched (Codex's own boot config bookkeeping is
 * outside Elwood's control and is not a model change).
 */
export function listCodexModels(options: ListModelsOptions): Promise<readonly AgentModelOption[]> {
  return probeModels(
    () =>
      startCodex({
        cwd: options.cwd,
        autotrust: true,
        sandbox: "read-only",
        approvalPolicy: "never",
        hooks: {},
        ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
        ...(options.autoupdate === undefined ? {} : { autoupdate: options.autoupdate }),
        ...(options.hookTimeoutMs === undefined ? {} : { hookTimeoutMs: options.hookTimeoutMs }),
        ...(options.strictVersionCheck === undefined
          ? {}
          : { strictVersionCheck: options.strictVersionCheck }),
      }),
    options,
  );
}
