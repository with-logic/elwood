/**
 * Finalizes adapter-dependent resume options, workspace, and images.
 * Implements PRD §12A.1/§12A.2 and C-CLI-03/C-CLI-04/C-CLI-06/C-CLI-08.
 */

import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { validateImages } from "../core/images/resolve.ts";
import { nonBlank, optional, reasoning, usage } from "./request-values.ts";
import type { CliAgent, EffectiveRunRequest, ResolvedRunRequest } from "./types.ts";

export async function finalizeRunRequest(
  draft: ResolvedRunRequest,
  stored?: { readonly agent: CliAgent; readonly cwd: string },
): Promise<EffectiveRunRequest> {
  validateStored(draft, stored);
  const agent = stored?.agent ?? draft.agent;
  validateEffectiveAgent(draft, agent);
  const cwd = draft.cwd ?? stored?.cwd;
  if (cwd === undefined) throw usage("The effective workspace could not be resolved.");
  if (!isAbsolute(cwd)) throw usage("The effective workspace must be absolute.");
  const info = await stat(cwd).catch(() => undefined);
  if (info?.isDirectory() !== true)
    throw usage("The effective workspace must be an existing directory.");
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid)
    throw usage("The effective workspace must be owned by the current user.");
  const images = await validateImages(
    draft.imagePaths.map((path) => ({ path: resolve(cwd, nonBlank(path, "image")) })),
  );
  return effectiveRequest(draft, agent, cwd, images);
}

function validateStored(
  draft: ResolvedRunRequest,
  stored: { readonly agent: CliAgent; readonly cwd: string } | undefined,
): void {
  if (draft.resume !== undefined && stored === undefined)
    throw usage("Stored session data is required to resolve a resume.");
  if (
    stored !== undefined &&
    draft.explicitAgent !== undefined &&
    draft.explicitAgent !== stored.agent
  )
    throw usage("The explicit agent conflicts with the stored session adapter.");
}

function validateEffectiveAgent(draft: ResolvedRunRequest, agent: CliAgent): void {
  if (agent === "codex" && draft.claudeOptionsExplicit === true)
    throw usage("Claude permission mode is incompatible with Codex.");
  if (agent === "claude" && draft.codexOptionsExplicit === true)
    throw usage("Codex launch options are incompatible with Claude.");
}

function effectiveRequest(
  draft: ResolvedRunRequest,
  agent: CliAgent,
  cwd: string,
  images: EffectiveRunRequest["images"],
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
  };
}
