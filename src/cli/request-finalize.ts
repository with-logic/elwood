/**
 * Finalizes adapter-dependent resume options, workspace, and images.
 * Implements PRD §12A.1/§12A.2 and C-CLI-03/C-CLI-04/C-CLI-06/C-CLI-08.
 */

import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { errnoCode } from "../core/errors.ts";
import { validateImages } from "../core/images/resolve.ts";
import { settingConflict } from "./request-validation.ts";
import { nonBlank, optional, reasoning, usage } from "./request-values.ts";
import type { CliAgent, EffectiveRunRequest, ResolvedRunRequest } from "./types.ts";

export async function finalizeRunRequest(
  draft: ResolvedRunRequest,
  stored?: { readonly agent: CliAgent; readonly cwd: string },
): Promise<EffectiveRunRequest> {
  validateStored(draft, stored);
  const agent = stored?.agent ?? draft.agent;
  validateEffectiveAgent(draft, agent);
  const cwd = stored?.cwd ?? draft.cwd;
  if (cwd === undefined) throw usage("The effective workspace could not be resolved.");
  if (!isAbsolute(cwd)) throw usage(`Workspace '${cwd}' must be an absolute path.`);
  const info = await workspaceStat(cwd);
  if (!info.isDirectory()) throw usage(`Workspace '${cwd}' is not a directory.`);
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid)
    throw usage(`Workspace '${cwd}' must be owned by the current user.`);
  const images = await validateImages(
    draft.imagePaths.map((path) => ({ path: resolve(cwd, nonBlank(path, "image")) })),
  );
  return effectiveRequest(draft, agent, cwd, images, stored !== undefined);
}

async function workspaceStat(cwd: string) {
  try {
    return await stat(cwd);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") throw usage(`Workspace '${cwd}' does not exist.`);
    throw usage(`Workspace '${cwd}' could not be inspected.`);
  }
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
        : settingConflict(sources, `the stored ${adapterName(stored.agent)} session`),
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

function adapterName(agent: CliAgent): "Claude" | "Codex" {
  return agent === "claude" ? "Claude" : "Codex";
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
    agent,
    cwd,
    images,
    ...optional(selected.model, "model"),
    ...optional(reasoning(agent, selected.reasoningEffort), "reasoningEffort"),
    ...(agent === "claude" && { permissionMode: draft.permissionMode ?? "dontAsk" }),
    ...(agent === "codex" && {
      sandbox: draft.sandbox ?? "workspace-write",
      approvalPolicy: draft.approvalPolicy ?? "never",
    }),
    ...optional(resolution, "resolution"),
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
