/**
 * Maps an effective CLI request (plus an optional stored record) onto the agent's own
 * command line through the adapters' shared launch-argument builders.
 * Implements PRD §12A.9 and C-CLI-25.
 */

import { claudeLaunchArguments } from "../../claude/command.ts";
import { codexEffortArguments, codexLaunchArguments } from "../../codex/command.ts";
import { elwoodError } from "../../core/errors.ts";
import { launchArgv } from "../../runtime/launch-arguments.ts";
import {
  claudeLaunchPosture,
  codexLaunchPosture,
  effectivePosture,
} from "../../state/launch-posture.ts";
import type { SessionRecord } from "../../state/store.ts";
import { optional } from "../request/values.ts";
import { claudeEffort, codexEffort } from "../session/launch.ts";
import type { EffectiveRunRequest } from "../types.ts";
import type { InteractiveLaunch } from "./spawn.ts";

/**
 * Built-in posture defaults are omitted (`source === "built-in"`): an unconfigured
 * interactive launch is the agent's own default experience, not Elwood's headless one.
 */
export function interactiveLaunch(
  request: EffectiveRunRequest,
  stored: SessionRecord | undefined,
): InteractiveLaunch {
  const sources = request.resolution?.sources;
  if (request.agent === "claude") {
    const posture = effectivePosture(
      stored?.claude.launch,
      claudeLaunchPosture({
        ...optional(selected(request.permissionMode, sources?.permissionMode), "permissionMode"),
      }),
    );
    const resumeId = stored === undefined ? undefined : conversationId(stored, "claude");
    return {
      agent: "claude",
      command: "claude",
      args: launchArgv(
        claudeLaunchArguments(
          {
            ...optional(request.model, "model"),
            ...optional(claudeEffort(request.reasoningEffort), "reasoningEffort"),
            ...posture,
          },
          resumeId,
        ),
      ),
      cwd: request.cwd,
    };
  }
  const posture = effectivePosture(
    stored?.codex.launch,
    codexLaunchPosture({
      ...optional(selected(request.sandbox, sources?.sandbox), "sandbox"),
      ...optional(selected(request.approvalPolicy, sources?.approvalPolicy), "approvalPolicy"),
    }),
  );
  return {
    agent: "codex",
    command: "codex",
    args: launchArgv([
      ...codexLaunchArguments({
        ...optional(request.model, "model"),
        ...posture,
        cwd: request.cwd,
        ...(stored === undefined ? {} : { resumeId: conversationId(stored, "codex") }),
      }),
      ...codexEffortArguments(codexEffort(request.reasoningEffort)),
    ]),
    cwd: request.cwd,
  };
}

/** Keep a posture value only when a flag, environment, config, or stored record chose it. */
function selected<T>(value: T | undefined, source: string | undefined): T | undefined {
  return source === undefined || source === "built-in" ? undefined : value;
}

function conversationId(stored: SessionRecord, agent: "claude" | "codex"): string {
  const id = stored[agent].resumeId;
  if (id === undefined) {
    const name = agent === "claude" ? "Claude" : "Codex";
    throw elwoodError("resume_unavailable", `Cannot resume ${name} without a ${name} session id.`);
  }
  return id;
}
