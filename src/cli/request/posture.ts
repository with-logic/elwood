/**
 * Resolves the effective adapter launch posture, including the agent-neutral
 * `--high-trust` expansion and the provenance of explicit per-agent posture.
 * Implements PRD §12A.2/§12A.4 and C-CLI-06/C-CLI-19/C-CLI-22.
 */

import { claudeHighTrustPosture, codexHighTrustPosture } from "../../core/high-trust.ts";
import {
  type CliAgent,
  type CliConfig,
  claudePermissionModes,
  codexApprovalPolicies,
  codexSandboxModes,
  type ParsedRunCommand,
} from "../types.ts";
import { booleanFlag, configKey, type SourcedValue, sourced } from "./sources.ts";
import { explicitPostureSources, validateHighTrust } from "./validation.ts";
import { choice, type EnvSettings } from "./values.ts";

/** A layered setting that remembers WHICH layer decided it (0 flag, 1 env, 2 config, 3 none). */
type RankedValue<T> = SourcedValue<T> & { readonly rank: number };

/** `--high-trust` / `ELWOOD_HIGH_TRUST` / `highTrust` config, defaulting to built-in false. */
function highTrustSetting(
  parsed: ParsedRunCommand,
  env: EnvSettings,
  config: CliConfig,
  path: string,
): RankedValue<boolean> {
  const setting = ranked(
    booleanFlag(parsed.flags.highTrust, "--high-trust", "--no-high-trust"),
    sourced(env.highTrust, "ELWOOD_HIGH_TRUST"),
    sourced(config.highTrust, configKey(path, "highTrust")),
  );
  return setting.value === undefined ? { value: false, source: "built-in", rank: 3 } : setting;
}

/**
 * The effective posture for `agent`, its per-field provenance, the resolved
 * high-trust switch, and which per-agent posture sources were explicit. Rejects
 * a flag/variable high trust combined with explicit per-agent posture (C-CLI-22).
 */
export function resolvePosture(
  parsed: ParsedRunCommand,
  env: EnvSettings,
  config: CliConfig,
  path: string,
  agent: CliAgent,
) {
  validateHighTrust(parsed, env);
  const highTrust = highTrustSetting(parsed, env, config, path);
  const permission = decided(
    ranked(
      sourced(parsed.flags.claudePermissionMode, "--claude-permission-mode"),
      sourced(env.claudePermissionMode, "ELWOOD_CLAUDE_PERMISSION_MODE"),
      sourced(config.claude?.permissionMode, configKey(path, "claude.permissionMode")),
    ),
    highTrust,
    claudeHighTrustPosture.permissionMode,
  );
  const sandbox = decided(
    ranked(
      sourced(parsed.flags.codexSandbox, "--codex-sandbox"),
      sourced(env.codexSandbox, "ELWOOD_CODEX_SANDBOX"),
      sourced(config.codex?.sandbox, configKey(path, "codex.sandbox")),
    ),
    highTrust,
    codexHighTrustPosture.sandbox,
  );
  const approval = decided(
    ranked(
      sourced(parsed.flags.codexApprovalPolicy, "--codex-approval-policy"),
      sourced(env.codexApprovalPolicy, "ELWOOD_CODEX_APPROVAL_POLICY"),
      sourced(config.codex?.approvalPolicy, configKey(path, "codex.approvalPolicy")),
    ),
    highTrust,
    codexHighTrustPosture.approvalPolicy,
  );
  const permissionMode = choice(permission.value, claudePermissionModes, "permissionMode");
  const sandboxMode = choice(sandbox.value, codexSandboxModes, "sandbox");
  const approvalPolicy = choice(approval.value, codexApprovalPolicies, "approvalPolicy");
  return {
    highTrust: { value: highTrust.value as boolean, source: highTrust.source },
    explicit: explicitPostureSources(parsed, env),
    permissionMode: permissionMode ?? (agent === "claude" ? "dontAsk" : undefined),
    sandbox: sandboxMode ?? (agent === "codex" ? "workspace-write" : undefined),
    approvalPolicy: approvalPolicy ?? (agent === "codex" ? "never" : undefined),
    sources: {
      permissionMode:
        permissionMode === undefined
          ? agent === "claude"
            ? "built-in"
            : "unset"
          : permission.source,
      sandbox:
        sandboxMode === undefined ? (agent === "codex" ? "built-in" : "unset") : sandbox.source,
      approvalPolicy:
        approvalPolicy === undefined ? (agent === "codex" ? "built-in" : "unset") : approval.source,
    },
  };
}

/** Flag, then environment, then config; `rank` records the deciding layer. */
function ranked<T>(
  flag: SourcedValue<T>,
  environment: SourcedValue<T>,
  config: SourcedValue<T>,
): RankedValue<T> {
  if (flag.value !== undefined) return { ...flag, rank: 0 };
  if (environment.value !== undefined) return { ...environment, rank: 1 };
  if (config.value !== undefined) return { ...config, rank: 2 };
  return { value: undefined, source: "unset", rank: 3 };
}

/**
 * High trust decides a posture field unless an explicit per-agent setting comes
 * from a MORE specific layer (an explicit flag/variable beats a SAVED high trust).
 * An explicit flag/variable posture alongside a flag/variable high trust never
 * reaches here: `validateHighTrust` rejects that combination (C-CLI-22).
 */
function decided<T extends string>(
  setting: RankedValue<T>,
  highTrust: RankedValue<boolean>,
  expansion: T,
): SourcedValue<T> {
  if (highTrust.value !== true) return setting;
  if (setting.value !== undefined && setting.rank < highTrust.rank) return setting;
  return sourced(expansion, highTrust.source);
}
