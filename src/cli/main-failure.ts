/**
 * Failure classification and protocol-aware error rendering shared by every command.
 * Implements PRD §12A.3/§12A.5 and C-CLI-11/C-CLI-17.
 */

import { ElwoodError } from "../core/errors.ts";
import { isOneOf } from "../core/predicates.ts";
import { writeJson } from "./output/json.ts";
import { JsonlRenderer } from "./output/jsonl.ts";
import { createCliSanitizer, formatDiagnosticValue } from "./output/sanitize.ts";
import type { CliCleanup, CliError } from "./output/types.ts";
import type { AsyncOutputSink } from "./stream.ts";
import {
  type CliAgent,
  type CliEnvironment,
  type CliOutputMode,
  CliValidationError,
  cliAgents,
} from "./types.ts";

export type StaticFailure = {
  readonly code: string;
  readonly message: string;
  readonly exitCode: 1 | 2;
};

export function cliFailure(error: unknown): StaticFailure {
  if (error instanceof CliValidationError)
    return { code: error.code, message: error.message, exitCode: 2 };
  if (error instanceof ElwoodError)
    return { code: error.code, message: error.message, exitCode: 1 };
  return { code: "runtime_error", message: "Elwood could not run the agent.", exitCode: 1 };
}

/** Build the canonical version-1 error record for a failure that produced no response. */
export function errorRecord(
  agent: CliAgent | null,
  failure: { readonly code: string; readonly message: string },
  durationMs: number,
  cleanup: CliCleanup = { action: "none", status: "succeeded" },
): CliError {
  const clean = createCliSanitizer();
  return {
    schemaVersion: 1,
    type: "error",
    agent,
    response: "",
    sessionId: null,
    durationMs,
    cleanup,
    error: { code: clean(failure.code), message: clean(failure.message) },
  };
}

/** Write one error record in the selected protocol: JSON/JSONL to stdout, text to stderr. */
export async function renderErrorRecord(
  output: CliOutputMode,
  record: CliError,
  stdout: AsyncOutputSink,
  stderr: AsyncOutputSink,
): Promise<void> {
  if (output === "json") await writeJson(stdout, record);
  else if (output === "jsonl")
    await new JsonlRenderer(stdout, () => record.durationMs).finish(record);
  else
    await stderr.write(
      `elwood: ${formatDiagnosticValue(record.error.message, createCliSanitizer())}\n`,
    );
}

export function explicitStructuredOutput(args: readonly string[]): CliOutputMode | undefined {
  if (args[0] === "config") return undefined;
  let candidate: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") break;
    if (arg === "--output") candidate = args[index + 1];
    else if (arg?.startsWith("--output=")) candidate = arg.slice("--output=".length);
  }
  return candidate === "json" || candidate === "jsonl" ? candidate : undefined;
}

/**
 * Agent an argument/config failure record reports before resolution ran: the
 * `--agent` flag, else `ELWOOD_AGENT` unless `--no-defaults` ignores it, else
 * `null` because nothing selected one (auto-detection had not chosen yet).
 */
export function agentHint(args: readonly string[], env: CliEnvironment): CliAgent | null {
  let flag: string | undefined;
  let useDefaults = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") break;
    if (arg === "--no-defaults") useDefaults = false;
    else if (arg === "--agent") flag = args[index + 1];
    else if (arg?.startsWith("--agent=")) flag = arg.slice("--agent=".length);
  }
  const candidate = flag ?? (useDefaults ? env["ELWOOD_AGENT"] : undefined);
  return isOneOf(candidate, cliAgents) ? candidate : null;
}
