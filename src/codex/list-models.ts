/**
 * Session-less Codex model enumeration. Implements PRD §5.3 and C-API-41.
 */

import { type ListModelsOptions, probeModels } from "../core/models/list.ts";
import { ownedProbeStateDir } from "../core/models/probe-state.ts";
import type { AgentModelOption } from "../core/models/rows.ts";
import { startCodex } from "./session/index.ts";

/**
 * Lists the models available to Codex WITHOUT a caller-held session: starts a
 * throwaway session (autotrust implied per C-API-41 so a trust prompt cannot stall
 * the probe), lists its models, and always cleans up — the session AND its owned
 * temp state directory, even if startup fails after allocating it. The probe runs
 * read-only with approvals off, and the picker is opened and cancelled only, so
 * the user's saved MODEL default stays untouched (Codex's own boot config
 * bookkeeping is outside Elwood's control and is not a model change).
 */
export function listCodexModels(options: ListModelsOptions): Promise<readonly AgentModelOption[]> {
  const state = ownedProbeStateDir("codex", options.stateDir);
  return probeModels(
    {
      start: () =>
        startCodex({
          cwd: options.cwd,
          stateDir: state.dir,
          autotrust: true,
          sandbox: "read-only",
          approvalPolicy: "never",
          hooks: {},
          ...(options.autoupdate === undefined ? {} : { autoupdate: options.autoupdate }),
          ...(options.hookTimeoutMs === undefined ? {} : { hookTimeoutMs: options.hookTimeoutMs }),
          ...(options.strictVersionCheck === undefined
            ? {}
            : { strictVersionCheck: options.strictVersionCheck }),
        }),
      removeState: state.remove,
    },
    options,
  );
}
