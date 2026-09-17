/**
 * One static table for the run command's long options. It drives argument
 * parsing, explicit-flag tracking, flag decoding, and "Did you mean" suggestions,
 * so a new option cannot be registered in one place and forgotten in another.
 * Implements PRD §12A.1/§12A.5 and C-CLI-02/C-CLI-06/C-CLI-20.
 */

import type { ParseArgsOptionsConfig } from "node:util";
import type { RunOptionKey } from "../types.ts";

export type RunOptionSpec =
  | {
      readonly type: "string";
      /** `RunFlags` field the option sets. */
      readonly key: RunOptionKey;
      readonly short?: string;
      readonly multiple?: true;
    }
  | {
      readonly type: "boolean";
      readonly key: RunOptionKey;
      /** Value assigned when the option is present; negative flags assign `false`. */
      readonly value: boolean;
    };

export const runOptionTable: Readonly<Record<string, RunOptionSpec>> = {
  agent: { type: "string", key: "agent" },
  output: { type: "string", key: "output" },
  timeout: { type: "string", key: "timeout" },
  trust: { type: "boolean", key: "trust", value: true },
  "no-trust": { type: "boolean", key: "trust", value: false },
  "high-trust": { type: "boolean", key: "highTrust", value: true },
  "no-high-trust": { type: "boolean", key: "highTrust", value: false },
  "state-dir": { type: "string", key: "stateDir" },
  verbose: { type: "boolean", key: "verbose", value: true },
  "no-verbose": { type: "boolean", key: "verbose", value: false },
  stream: { type: "boolean", key: "stream", value: true },
  "no-stream": { type: "boolean", key: "stream", value: false },
  debug: { type: "boolean", key: "debug", value: true },
  "no-defaults": { type: "boolean", key: "ignoreDefaults", value: true },
  head: { type: "boolean", key: "head", value: true },
  persona: { type: "string", key: "persona" },
  model: { type: "string", key: "model" },
  "reasoning-effort": { type: "string", key: "reasoningEffort" },
  "claude-permission-mode": { type: "string", key: "claudePermissionMode" },
  "codex-sandbox": { type: "string", key: "codexSandbox" },
  "codex-approval-policy": { type: "string", key: "codexApprovalPolicy" },
  cwd: { type: "string", key: "cwd", short: "C" },
  image: { type: "string", key: "images", multiple: true },
  "show-session-id": { type: "boolean", key: "showSessionId", value: true },
  keep: { type: "boolean", key: "keep", value: true },
  resume: { type: "string", key: "resume" },
  ephemeral: { type: "boolean", key: "ephemeral", value: true },
};

/** `node:util` parseArgs configuration: every run option plus the two metadata switches. */
export const parseOptions: ParseArgsOptionsConfig = {
  ...Object.fromEntries(
    Object.entries(runOptionTable).map(([name, spec]) => [name, parseOption(spec)]),
  ),
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
};

/** Every long option the parser accepts, for near-miss suggestions (C-CLI-20). */
export const longOptions: readonly string[] = Object.keys(parseOptions).map((name) => `--${name}`);

function parseOption(spec: RunOptionSpec): ParseArgsOptionsConfig[string] {
  if (spec.type === "boolean") return { type: "boolean" };
  return {
    type: "string",
    ...(spec.short === undefined ? {} : { short: spec.short }),
    ...(spec.multiple === undefined ? {} : { multiple: spec.multiple }),
  };
}
