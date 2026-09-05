/**
 * Side-effect-free routing for metadata, config, validation, and headless execution.
 * Implements PRD §12A and C-CLI-02/C-CLI-11/C-CLI-14/C-CLI-17.
 */

import { ElwoodError } from "../core/errors.ts";
import { parseCliArgs } from "./args.ts";
import { runConfigCommand } from "./config/commands.ts";
import { cliHelp } from "./help.ts";
import type { CliSignalSource } from "./lifecycle.ts";
import { writeJson } from "./output/json.ts";
import { JsonlRenderer } from "./output/jsonl.ts";
import { createCliSanitizer } from "./output/sanitize.ts";
import type { CliError } from "./output/types.ts";
import { resolveRunRequest } from "./request.ts";
import { executeRun } from "./run.ts";
import { prepareCliSession } from "./session.ts";
import { AsyncOutputSink, type CliWritable } from "./stream.ts";
import {
  type CliAgent,
  type CliEnvironment,
  type CliOutputMode,
  CliValidationError,
  type PromptStdin,
} from "./types.ts";
import { readCliVersion } from "./version.ts";

export type CliMainContext = {
  readonly stdout: CliWritable;
  readonly stderr: CliWritable;
  readonly stdin: PromptStdin;
  readonly env: CliEnvironment;
  readonly invocationCwd: string;
  readonly homeDir: string;
  readonly signals: CliSignalSource;
};
export type CliMainDependencies = {
  readonly version: () => string;
  readonly resolve: typeof resolveRunRequest;
  readonly prepare: typeof prepareCliSession;
  readonly execute: typeof executeRun;
  readonly now: () => number;
};

const defaults: CliMainDependencies = {
  version: readCliVersion,
  resolve: resolveRunRequest,
  prepare: prepareCliSession,
  execute: executeRun,
  now: Date.now,
};

/** Route one invocation and settle every selected output write before returning its status. */
export async function main(
  args: readonly string[],
  context: CliMainContext,
  dependencies: CliMainDependencies = defaults,
): Promise<number> {
  const stdout = new AsyncOutputSink(context.stdout);
  const stderr = new AsyncOutputSink(context.stderr);
  const startedAt = dependencies.now();
  let output = explicitStructuredOutput(args) ?? "text";
  let agent = agentHint(args);
  try {
    const parsed = parseCliArgs(args);
    if (parsed.command === "help") {
      await stdout.write(cliHelp);
      return 0;
    }
    if (parsed.command === "version") {
      await stdout.write(`${dependencies.version()}\n`);
      return 0;
    }
    if (parsed.command === "config") {
      await runConfigCommand(parsed.args, { ...context, stdout });
      return 0;
    }
    const resolved = await dependencies.resolve(parsed, context);
    output = resolved.output;
    agent = resolved.agent;
    const prepared = await dependencies.prepare(resolved);
    agent = prepared.request.agent;
    return await dependencies.execute(
      prepared.request,
      prepared.session,
      { stdout, stderr },
      { signals: context.signals },
    );
  } catch (error) {
    const failure = cliFailure(error);
    await renderFailure(
      output,
      agent,
      failure,
      Math.max(0, Math.trunc(dependencies.now() - startedAt)),
      stdout,
      stderr,
    ).catch(() => undefined);
    return failure.exitCode;
  } finally {
    await Promise.all([stdout.flush(), stderr.flush()]);
    stdout.dispose();
    stderr.dispose();
  }
}

type StaticFailure = { readonly code: string; readonly message: string; readonly exitCode: 1 | 2 };

function cliFailure(error: unknown): StaticFailure {
  if (error instanceof CliValidationError)
    return { code: error.code, message: error.message, exitCode: 2 };
  if (error instanceof ElwoodError)
    return { code: error.code, message: error.message, exitCode: 1 };
  return { code: "runtime_error", message: "Elwood could not run the agent.", exitCode: 1 };
}

async function renderFailure(
  output: CliOutputMode,
  agent: CliAgent,
  failure: StaticFailure,
  durationMs: number,
  stdout: AsyncOutputSink,
  stderr: AsyncOutputSink,
): Promise<void> {
  const clean = createCliSanitizer();
  const record: CliError = {
    schemaVersion: 1,
    type: "error",
    agent,
    response: "",
    sessionId: null,
    durationMs,
    cleanup: { action: "none", status: "succeeded" },
    error: { code: clean(failure.code), message: clean(failure.message) },
  };
  if (output === "json") await writeJson(stdout, record);
  else if (output === "jsonl") await new JsonlRenderer(stdout).finish(record);
  else await stderr.write(`elwood: ${record.error.code}: ${record.error.message}\n`);
}

function explicitStructuredOutput(args: readonly string[]): CliOutputMode | undefined {
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

function agentHint(args: readonly string[]): CliAgent {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") break;
    const value =
      arg === "--agent"
        ? args[index + 1]
        : arg?.startsWith("--agent=")
          ? arg.slice("--agent=".length)
          : undefined;
    if (value === "claude" || value === "codex") return value;
  }
  return "codex";
}
