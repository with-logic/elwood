/**
 * Head mode mirrors PTY output that is still batched or rendering when the run ends.
 * Drives the real Claude runtime, renderer, and HeadedDisplay over a fake PTY
 * (PRD §12A.6/§9.4, C-CLI-18, C-PERF-05).
 */

import { afterEach, expect, test, vi } from "vitest";
import { HeadedDisplay, terminalRestore } from "../../src/cli/head/display.ts";
import type { CliHeadTarget } from "../../src/cli/head/types.ts";
import { executeRun } from "../../src/cli/run/index.ts";
import { AsyncOutputSink } from "../../src/cli/stream.ts";
import { type ClaudeSessionApi, startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "../claude/helpers.ts";
import { effectiveRequest } from "./main-fakes.ts";
import { FakeCliSession, FakeSignals, MemoryWriter } from "./run-fakes.ts";

afterEach(resetFakes);

const request = effectiveRequest({ agent: "claude", keep: true });

/** The fake turn facade, with terminal events and cleanup owned by a real runtime session. */
class PtyBackedCliSession extends FakeCliSession {
  private readonly live: ClaudeSessionApi;
  constructor(live: ClaudeSessionApi) {
    super();
    this.live = live;
    live.on("terminal:data", (event) => this.emitter.emit("terminal:data", event));
    live.on("terminal:exit", (event) => this.emitter.emit("terminal:exit", event));
  }
  override close(): Promise<void> {
    return this.live.stop();
  }
}

async function runHeaded(streamWork: () => Promise<void>) {
  installFakes();
  const session = new PtyBackedCliSession(await startClaude({ cwd: tempDir() }));
  session.streamWork = streamWork;
  const display = new MemoryWriter();
  const stdout = new MemoryWriter();
  const target: CliHeadTarget = {
    output: display,
    size: () => ({ cols: 120, rows: 40 }),
    isRaw: () => false,
    setRawMode: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
    onInput: () => () => undefined,
    onResize: () => () => undefined,
  };
  const exitCode = await executeRun(
    request,
    session,
    { stdout: new AsyncOutputSink(stdout), stderr: new AsyncOutputSink(new MemoryWriter()) },
    { signals: new FakeSignals(), head: new HeadedDisplay(target) },
  );
  return { exitCode, display: display.value, stdout: stdout.value };
}

test("C-CLI-18 a final frame received as the turn completes reaches the headed display", async () => {
  const result = await runHeaded(() => {
    ptys[0]?.emitData("FINAL_FRAME");
    return Promise.resolve();
  });

  expect(result.exitCode).toBe(0);
  expect(result.display).toBe(`FINAL_FRAME${terminalRestore}`);
  expect(result.stdout).toBe("ok\n");
});

test("C-CLI-18 the agent's last words before a premature exit reach the headed display", async () => {
  const result = await runHeaded(() => {
    ptys[0]?.emitData("FATAL: agent crashed");
    ptys[0]?.emitExit({ exitCode: 1 });
    return new Promise(() => {});
  });

  expect(result.exitCode).toBe(1);
  expect(result.display).toBe(`FATAL: agent crashed${terminalRestore}`);
});
