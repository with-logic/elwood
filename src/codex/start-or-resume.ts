/**
 * Codex try-resume-else-start convenience entry point.
 * Implements PRD §5.6 and C-API-26.
 */

import { type StartOrResumeResult, startOrResume } from "../core/start-or-resume.ts";
import { startCodex } from "./session.ts";
import { resumeCodex } from "./session-resume.ts";
import type { CodexSessionApi, StartCodexOptions } from "./session-types.ts";

export type StartOrResumeCodexOptions = StartCodexOptions & {
  readonly elwoodSessionId?: string;
};

export function startOrResumeCodex(
  options: StartOrResumeCodexOptions,
): Promise<StartOrResumeResult<CodexSessionApi>> {
  const { elwoodSessionId, ...startOptions } = options;
  return startOrResume(
    elwoodSessionId,
    (id) =>
      resumeCodex({
        elwoodSessionId: id,
        cwd: startOptions.cwd,
        ...(startOptions.stateDir === undefined ? {} : { stateDir: startOptions.stateDir }),
        ...(startOptions.hooks === undefined ? {} : { hooks: startOptions.hooks }),
        ...(startOptions.initialSize === undefined
          ? {}
          : { initialSize: startOptions.initialSize }),
        ...(startOptions.autoupdate === undefined ? {} : { autoupdate: startOptions.autoupdate }),
        ...(startOptions.autotrust === undefined ? {} : { autotrust: startOptions.autotrust }),
        ...(startOptions.hookTimeoutMs === undefined
          ? {}
          : { hookTimeoutMs: startOptions.hookTimeoutMs }),
        ...(startOptions.sandbox === undefined ? {} : { sandbox: startOptions.sandbox }),
        ...(startOptions.approvalPolicy === undefined
          ? {}
          : { approvalPolicy: startOptions.approvalPolicy }),
        ...(startOptions.strictVersionCheck === undefined
          ? {}
          : { strictVersionCheck: startOptions.strictVersionCheck }),
      }),
    () => startCodex(startOptions),
  );
}
