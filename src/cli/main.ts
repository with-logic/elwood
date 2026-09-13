/**
 * Side-effect-free routing for metadata, config, listing, interactive, and headless execution.
 * Implements PRD §12A and C-CLI-02/C-CLI-11/C-CLI-14/C-CLI-17/C-CLI-21 through C-CLI-26.
 */

import { parseCliArgs } from "./args/index.ts";
import { runConfigCommand } from "./config/commands.ts";
import { HeadedDisplay } from "./head/display.ts";
import type { CliHeadTarget } from "./head/types.ts";
import { cliHelp } from "./help.ts";
import type { runInteractiveCommand } from "./interactive/index.ts";
import type { CliSignalSource } from "./lifecycle/index.ts";
import {
  agentHint,
  cliFailure,
  errorRecord,
  explicitStructuredOutput,
  renderErrorRecord,
} from "./main-failure.ts";
import type { executeModels } from "./models/index.ts";
import { resolveRunRequest, resolveRunSettings } from "./request/index.ts";
import { optional, usage } from "./request/values.ts";
import type { executeRun } from "./run/index.ts";
import type { prepareCliSession } from "./session/index.ts";
import { assertListingOutput, runSessionsCommand } from "./sessions/index.ts";
import { AsyncOutputSink, type CliWritable } from "./stream.ts";
import type { CliEnvironment, PromptStdin } from "./types.ts";
import { readCliVersion } from "./version.ts";

export type CliMainContext = {
  readonly stdout: CliWritable;
  readonly stderr: CliWritable;
  readonly stdin: PromptStdin;
  readonly stdoutIsTTY?: boolean;
  readonly env: CliEnvironment;
  readonly invocationCwd: string;
  readonly homeDir: string;
  readonly signals: CliSignalSource;
  readonly head?: CliHeadTarget;
};
export type CliMainDependencies = {
  readonly version: () => string;
  readonly resolve: typeof resolveRunRequest;
  readonly settings: typeof resolveRunSettings;
  readonly prepare: typeof prepareCliSession;
  readonly execute: typeof executeRun;
  readonly listModels: typeof executeModels;
  readonly interactive: typeof runInteractiveCommand;
  readonly now: () => number;
};

export const prepareDefaultCliSession: typeof prepareCliSession = async (...args) =>
  (await import("./session/index.ts")).prepareCliSession(...args);

export const executeDefaultCliRun: typeof executeRun = async (...args) =>
  (await import("./run/index.ts")).executeRun(...args);

export const executeDefaultModels: typeof executeModels = async (...args) =>
  (await import("./models/index.ts")).executeModels(...args);

export const runDefaultInteractive: typeof runInteractiveCommand = async (...args) =>
  (await import("./interactive/index.ts")).runInteractiveCommand(...args);

const defaults: CliMainDependencies = {
  version: readCliVersion,
  resolve: resolveRunRequest,
  settings: resolveRunSettings,
  prepare: prepareDefaultCliSession,
  execute: executeDefaultCliRun,
  listModels: executeDefaultModels,
  interactive: runDefaultInteractive,
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
  let agent = agentHint(args, context.env);
  let head: HeadedDisplay | undefined;
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
    if (parsed.command === "sessions") {
      return await runSessionsCommand(parsed, { ...context, stdout, stderr });
    }
    if (parsed.command === "interactive") {
      return await dependencies.interactive(parsed, context);
    }
    if (parsed.command === "models") {
      const settings = await dependencies.settings(parsed.run, context);
      assertListingOutput(settings, "models");
      output = settings.output;
      agent = settings.agent;
      const prepared = await dependencies.prepare(settings);
      agent = prepared.request.agent;
      return await dependencies.listModels(
        prepared.request,
        prepared.session,
        { stdout, stderr },
        { signals: context.signals },
      );
    }
    const resolved = await dependencies.resolve(parsed, context);
    output = resolved.output;
    agent = resolved.agent;
    if (resolved.head === true) {
      if (context.head === undefined) {
        throw usage("--head requires terminal stdin and stderr.");
      }
      head = new HeadedDisplay(context.head);
    }
    const prepared = await dependencies.prepare(
      head === undefined ? resolved : { ...resolved, initialSize: head.initialSize },
    );
    agent = prepared.request.agent;
    return await dependencies.execute(
      prepared.request,
      prepared.session,
      { stdout, stderr },
      { signals: context.signals, ...optional(head, "head") },
    );
  } catch (error) {
    await head?.close();
    const failure = cliFailure(error);
    const durationMs = Math.max(0, Math.trunc(dependencies.now() - startedAt));
    await renderErrorRecord(output, errorRecord(agent, failure, durationMs), stdout, stderr).catch(
      () => undefined,
    );
    return failure.exitCode;
  } finally {
    await head?.close();
    await Promise.all([stdout.flush(), stderr.flush()]);
    stdout.dispose();
    stderr.dispose();
  }
}
