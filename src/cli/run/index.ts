/**
 * Executes one prepared headless turn through the centralized lifecycle and output owners.
 * Implements PRD §12A.2-§12A.3 and C-CLI-05 through C-CLI-12/C-CLI-17.
 */

import { privateOutputSecrets } from "../../core/private-output-secrets.ts";
import type { ElwoodSessionStatus } from "../../core/types.ts";
import type { HeadedDisplay } from "../head/display.ts";
import { CliLifecycle, type CliLifecycleClock, type CliSignalSource } from "../lifecycle/index.ts";
import type { CliTerminalRecord } from "../output/types.ts";
import type { CliSessionFacade } from "../session/index.ts";
import type { AsyncOutputSink } from "../stream.ts";
import type { EffectiveRunRequest } from "../types.ts";
import { CodexUpdateAttentionGuard } from "../update-attention.ts";
import { RunOutput } from "./output.ts";
import { subscribeRunEvents } from "./subscribe.ts";

export type ExecuteRunIo = {
  readonly stdout: AsyncOutputSink;
  readonly stderr: AsyncOutputSink;
};
export type ExecuteRunDependencies = {
  readonly signals: CliSignalSource;
  readonly clock?: CliLifecycleClock;
  readonly head?: HeadedDisplay;
};

export async function executeRun(
  request: EffectiveRunRequest,
  session: CliSessionFacade,
  io: ExecuteRunIo,
  dependencies: ExecuteRunDependencies,
): Promise<number> {
  const lifecycle = new CliLifecycle(request, session, dependencies.signals, dependencies.clock);
  const output = new RunOutput(
    request,
    io.stdout,
    io.stderr,
    {
      consumerClosed: () => lifecycle.closeConsumer(),
      failed: (error) => lifecycle.fail(error),
    },
    () => lifecycle.durationMs(),
  );
  const head = dependencies.head;
  const updateAttention =
    request.agent === "codex"
      ? new CodexUpdateAttentionGuard(session, lifecycle, dependencies.clock)
      : undefined;
  const unsubscribers = subscribeRunEvents(
    request,
    session,
    lifecycle,
    {
      status: (status) => output.status(statusRecord(status)),
      warning: (event) => output.warning(event),
    },
    head,
    updateAttention,
  );
  let resizeEnabled = false;
  lifecycle.start();
  output.starting();
  try {
    head?.start({
      interrupt: () => lifecycle.interrupt(),
      resize: (size) => (resizeEnabled ? session.resize(size) : undefined),
      failed: (error) => lifecycle.fail(error),
    });
    lifecycle.beginLaunch();
    resizeEnabled = true;
    const setup = await lifecycle.race(session.setup());
    if (setup.completed) {
      const live = session.session;
      if (live !== undefined) output.setSecrets(privateOutputSecrets(live));
      output.runningPrompt();
      const turn = consumeTurn(request, session, output);
      await lifecycle.race(turn);
    }
  } catch (error) {
    lifecycle.fail(error);
  }
  resizeEnabled = false;
  updateAttention?.dispose();
  // Cleanup drains received PTY output (§9.4); keep mirroring until that tail has been
  // emitted, then restore the terminal before the final stdout protocol (§12A.6).
  const cleanup = await lifecycle.cleanup();
  await head?.close();
  try {
    await output.finish(() => terminalRecord(request, session, lifecycle, cleanup, output));
  } catch (error) {
    lifecycle.fail(error);
  }
  lifecycle.dispose();
  for (const unsubscribe of unsubscribers) unsubscribe();
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

function statusRecord(status: ElwoodSessionStatus) {
  return { schemaVersion: 1 as const, type: "status" as const, status };
}

function terminalRecord(
  request: EffectiveRunRequest,
  session: CliSessionFacade,
  lifecycle: CliLifecycle,
  cleanup: Awaited<ReturnType<CliLifecycle["cleanup"]>>,
  output: RunOutput,
): CliTerminalRecord {
  const response = output.response;
  const base = {
    schemaVersion: 1 as const,
    agent: request.agent,
    response,
    sessionId: cleanup.action === "preserve" ? session.preservedSessionId() : null,
    durationMs: lifecycle.durationMs(),
    cleanup,
  };
  const failure = lifecycle.failure;
  return failure === undefined
    ? { ...base, type: "result" }
    : {
        ...base,
        type: "error",
        error: { code: failure.code, message: output.sanitize(failure.message) },
      };
}
