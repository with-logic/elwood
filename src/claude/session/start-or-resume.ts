/**
 * Claude try-resume-else-start convenience entry point.
 * Implements PRD §5.2 and C-API-26.
 */

import { type StartOrResumeResult, startOrResume } from "../../core/start-or-resume.ts";
import type { ResumeClaudeOptions, StartClaudeOptions } from "../../core/types.ts";
import { compact } from "../../state/launch-posture.ts";
import { startClaude } from "./index.ts";
import type { ClaudeSessionApi } from "./interface.ts";
import { resumeClaude } from "./resume.ts";

export type StartOrResumeClaudeOptions = StartClaudeOptions & {
  readonly elwoodSessionId?: string;
};

export function startOrResumeClaude(
  options: StartOrResumeClaudeOptions,
): Promise<StartOrResumeResult<ClaudeSessionApi>> {
  const { elwoodSessionId, ...startOptions } = options;
  return startOrResume(
    elwoodSessionId,
    (id) => resumeClaude(resumeOptions(id, startOptions)),
    () => startClaude(startOptions),
  );
}

// Every resume-relevant start option is forwarded (PRD §5.2); `compact` drops the
// absent ones so `exactOptionalPropertyTypes` sees no explicit `undefined`.
function resumeOptions(elwoodSessionId: string, start: StartClaudeOptions): ResumeClaudeOptions {
  const forwarded = compact<Omit<ResumeClaudeOptions, "elwoodSessionId" | "cwd">>({
    stateDir: start.stateDir,
    hooks: start.hooks,
    initialSize: start.initialSize,
    reasoningEffort: start.reasoningEffort,
    permissionMode: start.permissionMode,
    allowedTools: start.allowedTools,
    disallowedTools: start.disallowedTools,
    tools: start.tools,
    autoupdate: start.autoupdate,
    autotrust: start.autotrust,
    highTrust: start.highTrust,
    hookTimeoutMs: start.hookTimeoutMs,
    strictVersionCheck: start.strictVersionCheck,
  });
  return { elwoodSessionId, cwd: start.cwd, ...forwarded };
}
