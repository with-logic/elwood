/**
 * Session-less Claude model enumeration. Implements PRD §5.3 and C-API-41.
 */

import { type ListModelsOptions, probeModels } from "../core/list-models.ts";
import type { AgentModelOption } from "../core/model-rows.ts";
import { startClaude } from "./session.ts";

/**
 * Lists the models available to Claude WITHOUT a caller-held session: starts a
 * throwaway session (autotrust implied so a trust prompt cannot stall the probe),
 * lists its models, and always tears it down (C-API-41). The picker is opened and
 * cancelled only, so the user's saved default and configuration stay untouched.
 */
export function listClaudeModels(options: ListModelsOptions): Promise<readonly AgentModelOption[]> {
  return probeModels(
    () =>
      startClaude({
        cwd: options.cwd,
        autotrust: true,
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
