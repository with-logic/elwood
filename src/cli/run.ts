/**
 * Executes one prepared headless turn through the centralized lifecycle and output owners.
 * Implements PRD §12A.2-§12A.3 and C-CLI-05 through C-CLI-12/C-CLI-17.
 */

import { privateOutputSecrets } from "../core/private-output-secrets.ts";
import { blockingTrustSpecs, trustPromptAllowlist } from "../core/trust-prompts.ts";
import type { ElwoodSessionStatus } from "../core/types.ts";
import type { HeadedDisplay } from "./head/display.ts";
import { CliLifecycle, type CliLifecycleClock, type CliSignalSource } from "./lifecycle.ts";
import type { CliTerminalRecord } from "./output/types.ts";
import { RunOutput } from "./run-output.ts";
import type { CliSessionFacade } from "./session.ts";
import type { AsyncOutputSink } from "./stream.ts";
import type { EffectiveRunRequest } from "./types.ts";
import { CodexUpdateAttentionGuard } from "./update-attention.ts";

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
  const output = new RunOutput(request, io.stdout, io.stderr, {
    consumerClosed: () => lifecycle.closeConsumer(),
    failed: (error) => lifecycle.fail(error),
  });
  const head = dependencies.head;
  const updateAttention =
    request.agent === "codex"
      ? new CodexUpdateAttentionGuard(session, lifecycle, dependencies.clock)
      : undefined;
  const unsubscribers = subscribe(request, session, lifecycle, output, head, updateAttention);
  let resizeEnabled = false;
  lifecycle.start();
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
      const turn = consumeTurn(request, session, output);
      await lifecycle.race(turn);
    }
  } catch (error) {
    lifecycle.fail(error);
  }
  resizeEnabled = false;
  updateAttention?.dispose();
  await head?.close();
  const cleanup = await lifecycle.cleanup();
  const terminal = terminalRecord(request, session, lifecycle, cleanup, output);
  try {
    await output.finish(terminal);
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

function subscribe(
  request: EffectiveRunRequest,
  session: CliSessionFacade,
  lifecycle: CliLifecycle,
  output: RunOutput,
  head: HeadedDisplay | undefined,
  updateAttention: CodexUpdateAttentionGuard | undefined,
): readonly (() => void)[] {
  const common = [
    session.on("activity", (event) => {
      if (event.kind === "attention" && event.label === "codex-update-prompt") {
        if (updateAttention === undefined) lifecycle.block(event.label);
        else updateAttention.attention();
      } else if (event.kind === "attention" && attentionNeedsHuman(request, event.label)) {
        lifecycle.block(event.label);
      }
      if (event.kind === "startup_prompt" && event.label === "update") {
        updateAttention?.succeeded();
      }
    }),
    session.on("status", ({ status }) => {
      updateAttention?.status(status);
      output.status(statusRecord(status));
    }),
    session.on("warning", (event) => {
      if (
        event.code === "startup_prompt_write_failed" &&
        event.agent === "codex" &&
        event.label === "update"
      ) {
        updateAttention?.writeFailed();
      }
      output.warning(event);
    }),
    session.on("terminal:exit", () => lifecycle.agentExited()),
  ];
  return head === undefined
    ? common
    : [...common, session.on("terminal:data", ({ data }) => head.write(data))];
}

function attentionNeedsHuman(request: EffectiveRunRequest, label: string): boolean {
  const matches = (prompt: (typeof trustPromptAllowlist)[number]) =>
    prompt.agent === request.agent && prompt.id === label;
  return (
    !trustPromptAllowlist.some(matches) ||
    blockingTrustSpecs(request.agent, request.trust).some(matches)
  );
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
