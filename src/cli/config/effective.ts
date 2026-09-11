/**
 * Renders validated effective CLI settings and provenance without starting an agent.
 * Implements PRD §12A.4 and C-CLI-19.
 */

import { claudeLaunchPosture, effectivePosture } from "../../state/launch-posture.ts";
import { readPrivateSessionRecord } from "../../state/private-session.ts";
import type { SessionRecord } from "../../state/store.ts";
import { parseCliArgs } from "../args/index.ts";
import { type AgentDetector, detectAvailableAgent } from "../request/agent-detect.ts";
import { finalizeRunRequest } from "../request/finalize.ts";
import { resolveRunSettings } from "../request/index.ts";
import { usage } from "../request/values.ts";
import type { AsyncOutputSink } from "../stream.ts";
import type { CliEnvironment } from "../types.ts";

export type EffectiveConfigContext = {
  readonly env: CliEnvironment;
  readonly invocationCwd: string;
  readonly homeDir: string;
  readonly stdout: AsyncOutputSink;
};

export type EffectiveConfigDependencies = {
  readonly readRecord: (stateDir: string, id: string) => SessionRecord;
  /** Login-shell command probe for an unselected agent; never starts an agent (C-CLI-21). */
  readonly detectAgent: AgentDetector;
};

const defaults: EffectiveConfigDependencies = {
  readRecord: readPrivateSessionRecord,
  detectAgent: detectAvailableAgent,
};

export async function writeEffectiveConfig(
  args: readonly string[],
  context: EffectiveConfigContext,
  overrides: Partial<EffectiveConfigDependencies> = {},
): Promise<void> {
  const dependencies = { ...defaults, ...overrides };
  const parsed = parseCliArgs(["run", ...args]);
  if (parsed.command !== "run") throw usage("config effective accepts run options only.");
  if (parsed.promptWords.length > 0) throw usage("config effective accepts options, not a prompt.");
  if (parsed.flags.images.length > 0)
    throw usage("config effective does not accept --image because it reads no prompt input.");
  const draft = await resolveRunSettings(parsed, context, dependencies.detectAgent);
  const stored =
    draft.resume === undefined ? undefined : dependencies.readRecord(draft.stateDir, draft.resume);
  const request = await finalizeRunRequest(
    draft,
    stored === undefined ? undefined : { agent: stored.adapter, cwd: stored.cwd },
  );
  const resolution = request.resolution!;
  const claudePosture =
    request.agent === "claude"
      ? effectivePosture(
          stored?.adapter === "claude" ? stored.claude.launch : undefined,
          claudeLaunchPosture({ permissionMode: request.permissionMode! }),
        )
      : undefined;
  const setting = <T>(value: T | undefined, source: string) => ({
    value: value ?? null,
    source,
  });
  const document = {
    schemaVersion: 1,
    type: "effective-settings",
    config: resolution.config,
    settings: {
      agent: setting(request.agent, resolution.sources.agent),
      workspace: setting(request.cwd, resolution.sources.workspace),
      model: setting(request.model, resolution.sources.model),
      reasoningEffort: setting(request.reasoningEffort, resolution.sources.reasoningEffort),
      timeoutMs: setting(request.timeoutMs, resolution.sources.timeoutMs),
      output: setting(request.output, resolution.sources.output),
      stream: setting(request.stream, resolution.sources.stream),
      verbose: setting(request.verbose, resolution.sources.verbose),
      debug: setting(request.debug === true, resolution.sources.debug),
      head: setting(draft.head === true, resolution.sources.head),
      trust: setting(request.trust, resolution.sources.trust),
      highTrust: setting(request.highTrust, resolution.sources.highTrust),
      stateDir: setting(request.stateDir, resolution.sources.stateDir),
      permissionMode: setting(claudePosture?.permissionMode, resolution.sources.permissionMode),
      allowedTools: setting(
        claudePosture?.allowedTools,
        claudeToolSource(request.agent, stored, request.resume, "allowedTools"),
      ),
      disallowedTools: setting(
        claudePosture?.disallowedTools,
        claudeToolSource(request.agent, stored, request.resume, "disallowedTools"),
      ),
      tools: setting(
        claudePosture?.tools,
        claudeToolSource(request.agent, stored, request.resume, "tools"),
      ),
      sandbox: setting(request.sandbox, resolution.sources.sandbox),
      approvalPolicy: setting(request.approvalPolicy, resolution.sources.approvalPolicy),
    },
  } as const;
  await context.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
}

type ClaudeToolSetting = "allowedTools" | "disallowedTools" | "tools";

function claudeToolSource(
  agent: "claude" | "codex",
  stored: SessionRecord | undefined,
  resume: string | undefined,
  key: ClaudeToolSetting,
): string {
  if (agent !== "claude") return "not applicable";
  if (stored?.adapter !== "claude" || stored.claude.launch?.[key] === undefined) return "unset";
  return `stored session ${resume}`;
}
