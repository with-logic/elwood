/**
 * Claude try-resume-else-start convenience entry point.
 * Implements PRD §5.2 and C-API-26.
 */

import { type StartOrResumeResult, startOrResume } from "../core/start-or-resume.ts";
import type { StartClaudeOptions } from "../core/types.ts";
import { startClaude } from "./session.ts";
import type { ClaudeSessionApi } from "./session-interface.ts";
import { resumeClaude } from "./session-resume.ts";

export type StartOrResumeClaudeOptions = StartClaudeOptions & {
  readonly elwoodSessionId?: string;
};

export function startOrResumeClaude(
  options: StartOrResumeClaudeOptions,
): Promise<StartOrResumeResult<ClaudeSessionApi>> {
  const { elwoodSessionId, ...startOptions } = options;
  return startOrResume(
    elwoodSessionId,
    (id) =>
      resumeClaude({
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
        ...(startOptions.permissionMode === undefined
          ? {}
          : { permissionMode: startOptions.permissionMode }),
        ...(startOptions.allowedTools === undefined
          ? {}
          : { allowedTools: startOptions.allowedTools }),
        ...(startOptions.disallowedTools === undefined
          ? {}
          : { disallowedTools: startOptions.disallowedTools }),
        ...(startOptions.tools === undefined ? {} : { tools: startOptions.tools }),
        ...(startOptions.strictVersionCheck === undefined
          ? {}
          : { strictVersionCheck: startOptions.strictVersionCheck }),
      }),
    () => startClaude(startOptions),
  );
}
