/** Sequential aggregate model listing with a command-wide deadline (PRD §12A.10, C-CLI-26). */

import type { CliFailure } from "../lifecycle/outcome.ts";
import type { CliMainContext, CliMainDependencies } from "../main.ts";
import { cliFailure, errorRecord, type StaticFailure } from "../main-failure.ts";
import type { CliCleanup } from "../output/types.ts";
import type { CliSessionFacade } from "../session/index.ts";
import type { CliAgent, CliOutputMode, ParsedRunCommand, ResolvedRunRequest } from "../types.ts";
import { cliAgents } from "../types.ts";
import type { ExecuteModelsIo } from "./index.ts";
import { renderCombinedModels } from "./render.ts";
import type { ModelsResult } from "./result.ts";
import { modelAgentInputs } from "./settings.ts";
import { ModelsSignals } from "./signals.ts";

type Failure = CliFailure | StaticFailure;

async function teardownPreparedSession(session: CliSessionFacade): Promise<CliCleanup> {
  try {
    await session.teardown();
    return { action: "teardown", status: "succeeded" };
  } catch {
    return { action: "teardown", status: "failed", error: "Cleanup failed." };
  }
}

export async function executeCombinedModels(
  parsed: ParsedRunCommand,
  output: CliOutputMode,
  context: CliMainContext,
  io: ExecuteModelsIo,
  dependencies: CliMainDependencies,
  startedAt: number,
): Promise<number> {
  const signals = new ModelsSignals(context.signals);
  const results: ModelsResult[] = [];
  let deadline: number | undefined;
  const stopped = (): Failure | undefined => {
    if (signals.interrupted) return { code: "interrupted", message: "Interrupted.", exitCode: 130 };
    if (deadline !== undefined && dependencies.now() >= deadline)
      return { code: "timeout", message: "Timed out.", exitCode: 124 };
    return undefined;
  };
  const failed = (agent: CliAgent, failure: Failure, cleanup?: CliCleanup) => {
    results.push({
      agent,
      error: errorRecord(agent, failure, Math.max(0, dependencies.now() - startedAt), cleanup),
      exitCode: failure.exitCode,
    });
  };
  try {
    // Validate both sets of settings before launching either adapter.
    const settings = new Map<CliAgent, ResolvedRunRequest>();
    const failures = new Map<CliAgent, Failure>();
    for (const agent of cliAgents) {
      const inputs = modelAgentInputs(parsed, context.env, agent);
      try {
        const request = await dependencies.settings(inputs.parsed, { ...context, env: inputs.env });
        if (request.timeoutMs !== undefined) deadline = startedAt + request.timeoutMs;
        settings.set(agent, request);
      } catch (error) {
        failures.set(agent, cliFailure(error));
      }
    }
    for (const agent of cliAgents) {
      const stop = stopped();
      if (stop !== undefined) {
        failed(agent, stop);
        break;
      }
      const invalid = failures.get(agent);
      if (invalid !== undefined) {
        failed(agent, invalid);
        continue;
      }
      let prepared: Awaited<ReturnType<CliMainDependencies["prepare"]>>;
      try {
        prepared = await dependencies.prepare(settings.get(agent)!);
      } catch (error) {
        const stop = stopped();
        if (stop !== undefined) {
          failed(agent, stop);
          break;
        }
        failed(agent, cliFailure(error));
        continue;
      }
      const afterPreparation = stopped();
      if (afterPreparation !== undefined) {
        const cleanup = await teardownPreparedSession(prepared.session);
        failed(agent, afterPreparation, cleanup);
        break;
      }
      await dependencies.listModels(
        {
          ...prepared.request,
          ...(deadline === undefined ? {} : { timeoutMs: deadline - dependencies.now() }),
        },
        prepared.session,
        io,
        { signals, onResult: (result) => results.push(result) },
      );
    }
    await renderCombinedModels(output, results, io);
    return Math.max(0, ...results.map((result) => ("error" in result ? result.exitCode : 0)));
  } finally {
    signals.dispose();
  }
}
