/**
 * `elwood models`: start one throwaway headless session, list its models through the
 * public picker operation, always tear it down, and render rows or an error record
 * under the run lifecycle's deadline, SIGINT, blocked-prompt, and cleanup rules.
 * Implements PRD §12A.10 and C-CLI-26.
 */

import type { AgentModelOption } from "../../core/models/rows.ts";
import type { ElwoodWarningEvent } from "../../core/warnings/index.ts";
import { CliLifecycle, type CliLifecycleClock, type CliSignalSource } from "../lifecycle/index.ts";
import { errorRecord, renderErrorRecord } from "../main-failure.ts";
import { progressFromWarning } from "../output/records.ts";
import { createCliSanitizer, formatDiagnosticValue } from "../output/sanitize.ts";
import { warningLine } from "../run/output-lines.ts";
import { subscribeRunEvents } from "../run/subscribe.ts";
import type { CliSessionFacade } from "../session/index.ts";
import type { AsyncOutputSink } from "../stream.ts";
import type { EffectiveRunRequest } from "../types.ts";
import { CodexUpdateAttentionGuard } from "../update-attention.ts";
import { renderModels } from "./render.ts";

export type ExecuteModelsIo = {
  readonly stdout: AsyncOutputSink;
  readonly stderr: AsyncOutputSink;
};
export type ExecuteModelsDependencies = {
  readonly signals: CliSignalSource;
  readonly clock?: CliLifecycleClock;
};

export async function executeModels(
  request: EffectiveRunRequest,
  session: CliSessionFacade,
  io: ExecuteModelsIo,
  dependencies: ExecuteModelsDependencies,
): Promise<number> {
  const lifecycle = new CliLifecycle(request, session, dependencies.signals, dependencies.clock);
  const clean = createCliSanitizer();
  const warnings: Promise<unknown>[] = [];
  const updateAttention =
    request.agent === "codex"
      ? new CodexUpdateAttentionGuard(session, lifecycle, dependencies.clock)
      : undefined;
  const unsubscribers = subscribeRunEvents(
    request,
    session,
    lifecycle,
    {
      status: () => undefined,
      warning: (event) => warnings.push(writeWarning(io.stderr, event, clean)),
    },
    undefined,
    updateAttention,
  );
  let models: readonly AgentModelOption[] | undefined;
  lifecycle.start();
  try {
    lifecycle.beginLaunch();
    const started = await lifecycle.race(session.start());
    if (started.completed) {
      const listed = await lifecycle.race(started.value.listModels());
      if (listed.completed) models = listed.value;
    }
  } catch (error) {
    lifecycle.fail(error);
  }
  updateAttention?.dispose();
  const cleanup = await lifecycle.cleanup();
  lifecycle.dispose();
  for (const unsubscribe of unsubscribers) unsubscribe();
  await Promise.all(warnings);
  const failure = lifecycle.failure;
  if (failure === undefined) {
    // Both races completed (the lifecycle only stops on a recorded failure), so rows exist.
    await renderModels(request.output, request.agent, models!, io.stdout);
    return 0;
  }
  const record = errorRecord(request.agent, failure, lifecycle.durationMs(), cleanup);
  await renderErrorRecord(request.output, record, io.stdout, io.stderr);
  return failure.exitCode;
}

function writeWarning(
  stderr: AsyncOutputSink,
  event: ElwoodWarningEvent,
  clean: (value: string) => string,
): Promise<unknown> {
  const record = progressFromWarning(event, clean);
  return stderr.write(warningLine(record, (value) => formatDiagnosticValue(value, clean)));
}
