/**
 * Session-less Claude model enumeration. Implements PRD §5.3 and C-API-41.
 */

import { randomUUID } from "node:crypto";
import { ElwoodError } from "../core/errors.ts";
import { type ListModelsOptions, probeModels } from "../core/models/list.ts";
import { ownedProbeStateDir } from "../core/models/probe-state.ts";
import type { AgentModelOption } from "../core/models/rows.ts";
import { startClaudeWithId } from "./session/index.ts";

/**
 * Lists the models available to Claude WITHOUT a caller-held session: starts a
 * throwaway session (autotrust implied per C-API-41 so a trust prompt cannot stall
 * the probe), lists its models, and always cleans up — the session AND its owned
 * temp state directory, even if startup fails after allocating it. The picker is
 * opened and cancelled only, so the user's saved default stays untouched. The implied
 * autotrust never approves a workspace prompt that says the folder declares hooks,
 * since trusting it would run them; the probe rejects instead (§5.3, C-CLAUDE-26).
 */
export function listClaudeModels(options: ListModelsOptions): Promise<readonly AgentModelOption[]> {
  const state = ownedProbeStateDir("claude", options.stateDir);
  return probeModels(
    {
      start: (refuse) =>
        startClaudeWithId(
          {
            cwd: options.cwd,
            stateDir: state.dir,
            autotrust: true,
            hooks: {},
            ...(options.autoupdate === undefined ? {} : { autoupdate: options.autoupdate }),
            ...(options.hookTimeoutMs === undefined
              ? {}
              : { hookTimeoutMs: options.hookTimeoutMs }),
            ...(options.strictVersionCheck === undefined
              ? {}
              : { strictVersionCheck: options.strictVersionCheck }),
          },
          randomUUID(),
          undefined,
          () => refuse(declaredHooksRefusal()),
        ),
      removeState: state.remove,
    },
    options,
  );
}

function declaredHooksRefusal(): ElwoodError {
  return new ElwoodError(
    "claude_start_failed",
    "Claude's workspace trust prompt says this folder declares hooks; listing models does not approve it.",
    { category: "workspace_hooks" },
  );
}
