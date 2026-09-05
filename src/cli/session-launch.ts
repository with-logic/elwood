/**
 * Adapter launch mapping for the headless CLI session facade.
 * Implements PRD §12A.2 and C-CLI-05/C-CLI-06/C-CLI-08.
 */

import { startClaudeWithId } from "../claude/session.ts";
import type { ClaudeSessionApi } from "../claude/session-interface.ts";
import { resumeClaude } from "../claude/session-resume.ts";
import { startCodexWithId } from "../codex/session.ts";
import { resumeCodex } from "../codex/session-resume.ts";
import type { CodexSessionApi } from "../codex/session-types.ts";
import type { ElwoodAgentSession } from "../core/agent-session.ts";
import {
  type ClaudeReasoningEffort,
  type CodexReasoningEffort,
  claudeReasoningEfforts,
  codexReasoningEfforts,
} from "../core/reasoning-effort.ts";
import type { EffectiveRunRequest } from "./types.ts";

export type CliLaunchDependencies = {
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
  request: EffectiveRunRequest,
  id: string,
  dependencies: CliLaunchDependencies,
): () => Promise<ClaudeSessionApi> {
  const common = {
    cwd: request.cwd,
    stateDir: request.stateDir,
    autotrust: request.trust,
    permissionMode: request.permissionMode ?? "dontAsk",
    ...defined(claudeEffort(request.reasoningEffort), "reasoningEffort"),
  };
  if (request.resume !== undefined)
    return () => dependencies.resumeClaude({ ...common, elwoodSessionId: id });
  return () =>
    dependencies.startClaude(
      { ...common, ...(request.model === undefined ? {} : { model: request.model }) },
      id,
    );
}

function codexLaunch(
  request: EffectiveRunRequest,
  id: string,
  dependencies: CliLaunchDependencies,
): () => Promise<CodexSessionApi> {
  const common = {
    cwd: request.cwd,
    stateDir: request.stateDir,
    autotrust: request.trust,
    sandbox: request.sandbox ?? "workspace-write",
    approvalPolicy: request.approvalPolicy ?? "never",
    ...defined(codexEffort(request.reasoningEffort), "reasoningEffort"),
  };
  if (request.resume !== undefined)
    return () => dependencies.resumeCodex({ ...common, elwoodSessionId: id });
  return () =>
    dependencies.startCodex(
      { ...common, ...(request.model === undefined ? {} : { model: request.model }) },
      id,
    );
}

function claudeEffort(value: string | undefined): ClaudeReasoningEffort | undefined {
  if (value === undefined) return undefined;
  return claudeReasoningEfforts.find((effort) => effort === value);
}

function codexEffort(value: string | undefined): CodexReasoningEffort | undefined {
  if (value === undefined) return undefined;
  return codexReasoningEfforts.find((effort) => effort === value);
}

function defined<K extends string, V>(value: V | undefined, key: K): { readonly [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { readonly [P in K]?: V });
}
