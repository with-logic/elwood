/** Select only the matching adapter's options for combined model probes (PRD §12A.10). */
import { optional } from "../request/values.ts";
import type { CliAgent, CliEnvironment, ParsedRunCommand } from "../types.ts";

export function modelAgentInputs(
  parsed: ParsedRunCommand,
  environment: CliEnvironment,
  agent: CliAgent,
) {
  const { claudePermissionMode, codexSandbox, codexApprovalPolicy, ...shared } = parsed.flags;
  const flags = {
    ...shared,
    agent,
    ...(agent === "claude"
      ? optional(claudePermissionMode, "claudePermissionMode")
      : {
          ...optional(codexSandbox, "codexSandbox"),
          ...optional(codexApprovalPolicy, "codexApprovalPolicy"),
        }),
  };
  const env = {
    ...environment,
    ELWOOD_AGENT: undefined,
    ...(agent === "claude"
      ? { ELWOOD_CODEX_SANDBOX: undefined, ELWOOD_CODEX_APPROVAL_POLICY: undefined }
      : { ELWOOD_CLAUDE_PERMISSION_MODE: undefined }),
  };
  return { parsed: { ...parsed, flags }, env };
}
