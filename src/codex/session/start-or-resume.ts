/**
 * Codex try-resume-else-start convenience entry point.
 * Implements PRD §5.6 and C-API-26; every resume-relevant start option (including
 * `reasoningEffort`, which a resume must re-supply per C-CODEX-21) is forwarded.
 */

import { type StartOrResumeResult, startOrResume } from "../../core/start-or-resume.ts";
import { compact } from "../../state/launch-posture.ts";
import { startCodex } from "./index.ts";
import { resumeCodex } from "./resume.ts";
import type { CodexSessionApi, ResumeCodexOptions, StartCodexOptions } from "./types.ts";

export type StartOrResumeCodexOptions = StartCodexOptions & {
  readonly elwoodSessionId?: string;
};

export function startOrResumeCodex(
  options: StartOrResumeCodexOptions,
): Promise<StartOrResumeResult<CodexSessionApi>> {
  const { elwoodSessionId, ...startOptions } = options;
  return startOrResume(
    elwoodSessionId,
    (id) => resumeCodex(resumeOptions(id, startOptions)),
    () => startCodex(startOptions),
  );
}

// Every resume-relevant start option is forwarded (PRD §5.6); `compact` drops the
// absent ones so `exactOptionalPropertyTypes` sees no explicit `undefined`.
function resumeOptions(elwoodSessionId: string, start: StartCodexOptions): ResumeCodexOptions {
  const forwarded = compact<Omit<ResumeCodexOptions, "elwoodSessionId" | "cwd">>({
    stateDir: start.stateDir,
    hooks: start.hooks,
    initialSize: start.initialSize,
    reasoningEffort: start.reasoningEffort,
    sandbox: start.sandbox,
    approvalPolicy: start.approvalPolicy,
    autoupdate: start.autoupdate,
    autotrust: start.autotrust,
    highTrust: start.highTrust,
    hookTimeoutMs: start.hookTimeoutMs,
    strictVersionCheck: start.strictVersionCheck,
  });
  return { elwoodSessionId, cwd: start.cwd, ...forwarded };
}
