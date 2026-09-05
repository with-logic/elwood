/**
 * Executes one prepared headless turn through the centralized lifecycle and output owners.
 * Implements PRD §12A.2-§12A.3 and C-CLI-05 through C-CLI-12/C-CLI-17.
 */

import { privateOutputSecrets } from "../core/private-output-secrets.ts";
import type { ElwoodSessionStatus } from "../core/types.ts";
import { CliLifecycle, type CliLifecycleClock, type CliSignalSource } from "./lifecycle.ts";
import { createCliSanitizer } from "./output/sanitize.ts";
import type { CliTerminalRecord } from "./output/types.ts";
import { RunOutput } from "./run-output.ts";
import type { CliSessionFacade } from "./session.ts";
import type { AsyncOutputSink } from "./stream.ts";
import type { EffectiveRunRequest } from "./types.ts";

export type ExecuteRunIo = {
  readonly stdout: AsyncOutputSink;
  readonly stderr: AsyncOutputSink;
};
export type ExecuteRunDependencies = {
  readonly signals: CliSignalSource;
  readonly clock?: CliLifecycleClock;
};

export async function executeRun(
  request: EffectiveRunRequest,
  session: CliSessionFacade,
  io: ExecuteRunIo,
  dependencies: ExecuteRunDependencies,
): Promise<number> {
  const lifecycle = new CliLifecycle(request, session, dependencies.signals, dependencies.clock);
  const output = new RunOutput(request, io.stdout, io.stderr, {
    consumerClosed: () => lifecycle.closeConsumer(),
    failed: (error) => lifecycle.fail(error),
  });
  const unsubscribers = subscribe(session, lifecycle, output);
  lifecycle.start();
  try {
    lifecycle.beginLaunch();
    const setup = await lifecycle.race(session.setup());
    if (setup.completed) {
      const live = session.session;
      if (live !== undefined) output.setSecrets(privateOutputSecrets(live));
      const turn = consumeTurn(request, session, output);
      await lifecycle.race(turn);
    }
  } catch (error) {
    lifecycle.fail(error);
  }
  const cleanup = await lifecycle.cleanup();
  await output.flush();
  const terminal = terminalRecord(request, session, lifecycle, cleanup, output.response);
  try {
    await output.finish(terminal);
  } catch (error) {
    lifecycle.fail(error);
  }
  lifecycle.dispose();
  for (const unsubscribe of unsubscribers) unsubscribe();
  await Promise.all([io.stdout.flush(), io.stderr.flush()]);
  io.stdout.dispose();
  io.stderr.dispose();
  return lifecycle.failure?.exitCode ?? 0;
}

async function consumeTurn(
  request: EffectiveRunRequest,
  session: CliSessionFacade,
  output: RunOutput,
): Promise<void> {
  for await (const event of session.stream(request.prompt, { images: request.images })) {
    await output.turn(event);
  }
}

function subscribe(
  session: CliSessionFacade,
  lifecycle: CliLifecycle,
  output: RunOutput,
): readonly (() => void)[] {
  return [
    session.on("activity", (event) => {
      if (event.kind === "attention") lifecycle.block(event.label);
    }),
    session.on("status", ({ status }) => output.status(statusRecord(status))),
    session.on("warning", (event) => output.warning(event)),
    session.on("terminal:exit", () => lifecycle.agentExited()),
  ];
}

function statusRecord(status: ElwoodSessionStatus) {
  return { schemaVersion: 1 as const, type: "status" as const, status };
}

function terminalRecord(
  request: EffectiveRunRequest,
  session: CliSessionFacade,
  lifecycle: CliLifecycle,
  cleanup: Awaited<ReturnType<CliLifecycle["cleanup"]>>,
  response: string,
): CliTerminalRecord {
  const clean = createCliSanitizer(
    session.session === undefined ? [] : privateOutputSecrets(session.session),
  );
  const base = {
    schemaVersion: 1 as const,
    agent: request.agent,
    response: clean(response),
    sessionId: cleanup.action === "preserve" ? session.id : null,
    durationMs: lifecycle.durationMs(),
    cleanup,
  };
  const failure = lifecycle.failure;
  return failure === undefined
    ? { ...base, type: "result" }
    : {
        ...base,
        type: "error",
        error: { code: failure.code, message: clean(failure.message) },
      };
}
