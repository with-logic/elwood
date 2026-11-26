/**
 * Session-less Claude model enumeration. Implements PRD §5.3 and C-API-41.
 */

import { randomUUID } from "node:crypto";
import { ElwoodError } from "../core/errors.ts";
import { type ListModelsOptions, probeModels } from "../core/models/list.ts";
import { ownedProbeStateDir } from "../core/models/probe-state.ts";
import type { AgentModelOption } from "../core/models/rows.ts";
import { claudeHooksDisclosureVersion } from "./preflight.ts";
import { startClaudeWithId } from "./session/index.ts";

/**
 * Lists the models available to Claude WITHOUT a caller-held session: starts a
 * throwaway session (autotrust implied per C-API-41 so a trust prompt cannot stall
 * the probe), lists its models, and always cleans up — the session AND its owned
 * temp state directory, even if startup fails after allocating it. The picker is
 * opened and cancelled only, so the user's saved default stays untouched. The implied
 * autotrust never approves a workspace prompt for a folder whose hooks could run: one that
 * discloses hooks, or any from a Claude that cannot disclose them. The probe rejects instead
 * (§5.3, C-CLAUDE-26).
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
          (hooksDisclosed) => refuse(workspaceTrustRefusal(hooksDisclosed)),
        ),
      removeState: state.remove,
    },
    options,
  );
}

function workspaceTrustRefusal(hooksDisclosed: boolean): ElwoodError {
  const reason = hooksDisclosed
    ? "Claude's workspace trust prompt says this folder has hooks"
    : `Claude older than ${claudeHooksDisclosureVersion}, or of an unknown version, cannot say whether this folder has hooks`;
  return new ElwoodError(
    "claude_start_failed",
    `${reason}; listing models does not approve its workspace trust prompt. List models from a folder Claude already trusts.`,
    { category: "workspace_hooks" },
  );
}
