/**
 * Session-less Claude model enumeration. Implements PRD §5.3 and C-API-41.
 */

import { randomUUID } from "node:crypto";
import { ElwoodError } from "../core/errors.ts";
import { type ListModelsOptions, probeModels } from "../core/models/list.ts";
import { ownedProbeStateDir } from "../core/models/probe-state.ts";
import type { AgentModelOption } from "../core/models/rows.ts";
import { claudeHooksDisclosureVersion } from "./preflight.ts";
import type { ProbeTrustRefusal } from "./probe-trust.ts";
import { startClaudeWithId } from "./session/index.ts";

/**
 * Lists the models available to Claude WITHOUT a caller-held session: starts a
 * throwaway session (autotrust implied per C-API-41 so a trust prompt cannot stall
 * the probe), lists its models, and always cleans up — the session AND its owned
 * temp state directory, even if startup fails after allocating it. The picker is
 * opened and cancelled only, so the user's saved default stays untouched. The implied
 * autotrust approves only the plain workspace prompt, from a Claude that discloses hooks; it
 * rejects any prompt whose answer could run the folder's code instead (§5.3, C-CLAUDE-26,
 * C-CLAUDE-29).
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
          (refusal) => refuse(probeRefusalError(refusal)),
        ),
      removeState: state.remove,
    },
    options,
  );
}

/** What in the folder the probe declined to trust, or that it could not verify the prompt (§10). */
export type ProbeRefusalCategory =
  | "workspace_hooks"
  | "workspace_mcp_servers"
  | "workspace_settings"
  | "workspace_plugins"
  | "workspace_skills"
  | "workspace_unverified";

/** Each refusal's typed category and why the probe refused (§5.3, §10). */
const refusals: Readonly<
  Record<ProbeTrustRefusal, readonly [category: ProbeRefusalCategory, reason: string]>
> = {
  hooks_disclosed: [
    "workspace_hooks",
    "Claude's workspace trust prompt says this folder has hooks",
  ],
  hooks_undisclosable: [
    "workspace_hooks",
    `Claude older than ${claudeHooksDisclosureVersion}, or of an unknown version, shows a workspace trust prompt that cannot say whether this folder has hooks`,
  ],
  mcp_servers_disclosed: [
    "workspace_mcp_servers",
    "Claude's workspace trust prompt says this folder declares MCP servers",
  ],
  settings_disclosed: [
    "workspace_settings",
    "Claude's workspace trust prompt says this folder has project settings, which can enable plugins that run commands",
  ],
  mcp_server_prompt: [
    "workspace_mcp_servers",
    "Claude asks to use an MCP server this folder declares",
  ],
  plugin_prompt: ["workspace_plugins", "Claude asks to trust a plugin"],
  skill_prompt: ["workspace_skills", "Claude asks to load a skill"],
  workspace_unverified: [
    "workspace_unverified",
    "Elwood cannot verify Claude's workspace trust prompt",
  ],
};

function probeRefusalError(refusal: ProbeTrustRefusal): ElwoodError {
  const [category, reason] = refusals[refusal];
  return new ElwoodError(
    "claude_start_failed",
    `${reason}; listing models does not answer that prompt. List models from a folder Claude already trusts, with no trust prompts left to answer.`,
    { category },
  );
}
