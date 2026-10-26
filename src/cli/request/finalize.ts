/**
 * Finalizes adapter-dependent resume options, workspace, and images.
 * Implements PRD §12A.1/§12A.2/§12A.5 and C-CLI-03/C-CLI-04/C-CLI-06/C-CLI-08/C-CLI-15.
 */

import { resolve } from "node:path";
import { validateImages } from "../../core/images/resolve.ts";
import { claudeReasoningEfforts, codexReasoningEfforts } from "../../core/reasoning-effort.ts";
import {
  agentDisplayName,
  type CliAgent,
  type EffectiveAgentEffort,
  type EffectiveRunRequest,
  type ResolvedRunRequest,
} from "../types.ts";
import { settingConflict } from "./validation.ts";
import { choice, nonBlank, optional, usage } from "./values.ts";
import { validateWorkspace } from "./workspace.ts";

export async function finalizeRunRequest(
  draft: ResolvedRunRequest,
  stored?: { readonly agent: CliAgent; readonly cwd: string },
): Promise<EffectiveRunRequest> {
  validateStored(draft, stored);
  const agent = stored?.agent ?? draft.agent;
  validateEffectiveAgent(draft, agent);
  const cwd = await validateWorkspace(stored?.cwd ?? draft.cwd);
  const images = await validateImages(
    draft.imagePaths.map((path) => ({ path: resolve(cwd, nonBlank(path, "image")) })),
  );
  return effectiveRequest(draft, agent, cwd, images, stored !== undefined);
}

function validateStored(
  draft: ResolvedRunRequest,
  stored: { readonly agent: CliAgent; readonly cwd: string } | undefined,
): void {
  if (draft.resume !== undefined && stored === undefined)
    throw usage("Stored session data is required to resolve a resume.");
  if (stored !== undefined && draft.cwdExplicit === true)
    throw usage("--cwd cannot be used with --resume; resume uses the stored workspace.");
  if (
    stored !== undefined &&
    draft.explicitAgent !== undefined &&
    draft.explicitAgent !== stored.agent
  ) {
    const sources = invocationSources(draft.resolution?.sources.agent);
    throw usage(
      sources.length === 0
        ? "The explicit agent conflicts with the stored session adapter."
        : settingConflict(sources, `the stored ${agentDisplayName(stored.agent)} session`),
    );
  }
}

function validateEffectiveAgent(draft: ResolvedRunRequest, agent: CliAgent): void {
  if (agent === "codex" && draft.claudeOptionsExplicit === true) {
    const sources = invocationSources(draft.resolution?.sources.permissionMode);
    throw usage(
      sources.length === 0
        ? "Claude permission mode is incompatible with Codex."
        : settingConflict(sources, "Codex"),
    );
  }
  if (agent === "claude" && draft.codexOptionsExplicit === true) {
    const sources = invocationSources(
      draft.resolution?.sources.sandbox,
      draft.resolution?.sources.approvalPolicy,
    );
    throw usage(
      sources.length === 0
        ? "Codex launch options are incompatible with Claude."
        : settingConflict(sources, "Claude"),
    );
  }
}

function invocationSources(...sources: readonly (string | undefined)[]): readonly string[] {
  return sources.filter(
    (source): source is string =>
      source?.startsWith("--") === true || source?.startsWith("ELWOOD_") === true,
  );
}

function effectiveRequest(
  draft: ResolvedRunRequest,
  agent: CliAgent,
  cwd: string,
  images: EffectiveRunRequest["images"],
  resumed: boolean,
): EffectiveRunRequest {
  const selected = draft.agentOptions?.[agent] ?? {
    ...(draft.model === undefined ? {} : { model: draft.model }),
    ...(draft.reasoningEffort === undefined ? {} : { reasoningEffort: draft.reasoningEffort }),
  };
  const {
    agent: _agent,
    imagePaths: _imagePaths,
    cwd: _cwd,
    model: _model,
    reasoningEffort: _effort,
    permissionMode: _permission,
    sandbox: _sandbox,
    approvalPolicy: _approval,
    agentOptions: _agentOptions,
    claudeOptionsExplicit: _claudeExplicit,
    codexOptionsExplicit: _codexExplicit,
    head: _head,
    ...rest
  } = draft;
  const resolution = effectiveResolution(draft, agent, resumed);
  return {
    ...rest,
    cwd,
    images,
    ...optional(selected.model, "model"),
    ...agentEffort(agent, selected.reasoningEffort),
    ...(agent === "claude" && { permissionMode: draft.permissionMode ?? "dontAsk" }),
    ...(agent === "codex" && {
      sandbox: draft.sandbox ?? "workspace-write",
      approvalPolicy: draft.approvalPolicy ?? "never",
    }),
    ...optional(resolution, "resolution"),
  };
}

/** Narrow the effort to the effective adapter's vocabulary before launch (C-CLI-06). */
function agentEffort(agent: CliAgent, value: string | undefined): EffectiveAgentEffort {
  return agent === "claude"
    ? {
        agent,
        ...optional(choice(value, claudeReasoningEfforts, "reasoningEffort"), "reasoningEffort"),
      }
    : {
        agent,
        ...optional(choice(value, codexReasoningEfforts, "reasoningEffort"), "reasoningEffort"),
      };
}

function effectiveResolution(
  draft: ResolvedRunRequest,
  agent: CliAgent,
  resumed: boolean,
): ResolvedRunRequest["resolution"] {
  const resolution = draft.resolution;
  if (resolution === undefined) return undefined;
  return {
    ...resolution,
    sources: {
      ...resolution.sources,
      agent: resumed ? `stored session ${draft.resume}` : resolution.sources.agent,
      workspace: resumed ? `stored session ${draft.resume}` : resolution.sources.workspace,
      model: resolution.agentOptionSources[agent].model,
      reasoningEffort: resolution.agentOptionSources[agent].reasoningEffort,
      permissionMode:
        agent === "claude"
          ? draft.permissionMode === undefined
            ? "built-in"
            : resolution.sources.permissionMode
          : "not applicable",
      sandbox:
        agent === "codex"
          ? draft.sandbox === undefined
            ? "built-in"
            : resolution.sources.sandbox
          : "not applicable",
      approvalPolicy:
        agent === "codex"
          ? draft.approvalPolicy === undefined
            ? "built-in"
            : resolution.sources.approvalPolicy
          : "not applicable",
    },
  };
}
