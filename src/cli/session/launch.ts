/**
 * Adapter launch mapping for the headless CLI session facade.
 * Implements PRD §12A.2/§12A.5 and C-CLI-05/C-CLI-06/C-CLI-08/C-CLI-15.
 */

import { startClaudeWithId } from "../../claude/session/index.ts";
import type { ClaudeSessionApi } from "../../claude/session/interface.ts";
import { resumeClaude } from "../../claude/session/resume.ts";
import { startCodexWithId } from "../../codex/session/index.ts";
import { resumeCodex } from "../../codex/session/resume.ts";
import type { CodexSessionApi } from "../../codex/session/types.ts";
import type { ElwoodAgentSession } from "../../core/agent-session.ts";
import {
  type ClaudeReasoningEffort,
  type CodexReasoningEffort,
  claudeReasoningEfforts,
  codexReasoningEfforts,
} from "../../core/reasoning-effort.ts";
import { ensurePrivateStateRoot } from "../../state/private-session.ts";
import { optional } from "../request/values.ts";
import type { EffectiveRunRequest } from "../types.ts";

export type CliLaunchDependencies = {
  readonly prepareStateRoot: (stateDir: string) => void;
  readonly startClaude: (
    options: Parameters<typeof startClaudeWithId>[0],
    id: string,
  ) => Promise<ClaudeSessionApi>;
  readonly resumeClaude: typeof resumeClaude;
  readonly startCodex: (
    options: Parameters<typeof startCodexWithId>[0],
    id: string,
  ) => Promise<CodexSessionApi>;
  readonly resumeCodex: typeof resumeCodex;
};

export const defaultCliLaunchDependencies: CliLaunchDependencies = {
  prepareStateRoot: ensurePrivateStateRoot,
  startClaude: startClaudeWithId,
  resumeClaude,
  startCodex: startCodexWithId,
  resumeCodex,
};

/** Build exactly one adapter path; resumes never fall back to a new session. */
export function createCliLaunch(
  request: EffectiveRunRequest,
  id: string,
  dependencies: CliLaunchDependencies,
): () => Promise<ElwoodAgentSession> {
  if (request.agent === "claude") return claudeLaunch(request, id, dependencies);
  return codexLaunch(request, id, dependencies);
}

function claudeLaunch(
  request: EffectiveRunRequest & { readonly agent: "claude" },
  id: string,
  dependencies: CliLaunchDependencies,
): () => Promise<ClaudeSessionApi> {
  const common = {
    cwd: request.cwd,
    stateDir: request.stateDir,
    autotrust: request.trust,
    permissionMode: request.permissionMode ?? "dontAsk",
    ...optional(request.initialSize, "initialSize"),
    ...optional(request.reasoningEffort, "reasoningEffort"),
  };
  if (request.resume !== undefined)
    return () => dependencies.resumeClaude({ ...common, elwoodSessionId: id });
  return async () => {
    dependencies.prepareStateRoot(request.stateDir);
    return await dependencies.startClaude(
      { ...common, ...(request.model === undefined ? {} : { model: request.model }) },
      id,
    );
  };
}

function codexLaunch(
  request: EffectiveRunRequest & { readonly agent: "codex" },
  id: string,
  dependencies: CliLaunchDependencies,
): () => Promise<CodexSessionApi> {
  const common = {
    cwd: request.cwd,
    stateDir: request.stateDir,
    autotrust: request.trust,
    sandbox: request.sandbox ?? "workspace-write",
    approvalPolicy: request.approvalPolicy ?? "never",
    ...optional(request.initialSize, "initialSize"),
    ...optional(request.reasoningEffort, "reasoningEffort"),
  };
  if (request.resume !== undefined)
    return () => dependencies.resumeCodex({ ...common, elwoodSessionId: id });
  return async () => {
    dependencies.prepareStateRoot(request.stateDir);
    return await dependencies.startCodex(
      { ...common, ...(request.model === undefined ? {} : { model: request.model }) },
      id,
    );
  };
}

export function claudeEffort(value: string | undefined): ClaudeReasoningEffort | undefined {
  if (value === undefined) return undefined;
  return claudeReasoningEfforts.find((effort) => effort === value);
}

export function codexEffort(value: string | undefined): CodexReasoningEffort | undefined {
  if (value === undefined) return undefined;
  return codexReasoningEfforts.find((effort) => effort === value);
}
