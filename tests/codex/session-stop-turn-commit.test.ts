/**
 * A graceful shutdown right after a `Stop`-hook `ready` waits for Codex to record the
 * turn (PRD §5.7, C-LIFE-13). Codex records `task_complete` only after the hook returns,
 * and a process signaled before then leaves the resumed conversation interrupted.
 */
import { afterEach, expect, test, vi } from "vitest";
import { CodexTranscriptWatcher } from "../../src/codex/transcript/index.ts";
import type { ElwoodWarningEvent } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import {
  appendRecord,
  pause,
  runningTurn,
  shutdownAtReady,
  unboundedCommitWait,
} from "./turn-commit-harness.ts";

afterEach(() => {
  vi.restoreAllMocks();
  resetFakes();
});

test.each([
  ["stop", "SIGTERM"],
  ["teardown", "SIGKILL"],
] as const)("C-LIFE-13 %s at a Stop-hook ready signals Codex once the turn is recorded, closing input and loops at once", async (verb, signal) => {
  installFakes();
  unboundedCommitWait();
  const cwd = tempDir();
  const { session, path } = await runningTurn(cwd);
  const { shutdown } = await shutdownAtReady(session, cwd, verb, path);
  const writes = ptys[0]!.writes.length;
  await expect(session.sendMessage("too late")).rejects.toMatchObject({
    code: "session_not_running",
  });
  await expect(
    session.createLoop({ mode: "fixed", intervalMs: 60_000, message: "too late" }),
  ).rejects.toMatchObject({ code: "session_not_running" });
  // Another turn's end, and a record that ends no turn, are not this turn's record.
  appendRecord(path, "task_complete", "turn-0");
  appendRecord(path, "token_count", "turn-1");
  await pause(300);
  expect(ptys[0]!.killSignals).toEqual([]);
  expect(ptys[0]!.writes).toHaveLength(writes);
  // Polled from the transcript: with the bound lifted, nothing else can end the wait.
  appendRecord(path, "task_complete", "turn-1");
  await shutdown;
  expect(ptys[0]!.killSignals).toEqual([signal]);
});

test("C-LIFE-13 a CLI that exits on its own before recording the turn releases the wait", async () => {
  installFakes();
  unboundedCommitWait();
  const cwd = tempDir();
  const { session, path } = await runningTurn(cwd);
  const { shutdown } = await shutdownAtReady(session, cwd, "stop", path);
  await pause(100);
  ptys[0]!.emitExit({ exitCode: 0 });
  await shutdown;
  // Nothing was signaled: the exit was the CLI's own.
  expect(ptys[0]!.killSignals).toEqual([]);
  expect(session.status).toBe("exited");
});

test("C-LIFE-13 a transcript read failure during the wait is reported, and the bound still ends it", async () => {
  installFakes();
  const cwd = tempDir();
  const { session, path } = await runningTurn(cwd);
  const warnings: ElwoodWarningEvent[] = [];
  session.on("warning", (event) => warnings.push(event));
  const { shutdown } = await shutdownAtReady(session, cwd, "stop", path);
  vi.spyOn(CodexTranscriptWatcher.prototype, "scan").mockImplementation(() => {
    throw new Error("scan failed");
  });
  // Contained, not an uncaught exception from the wait's poll timer.
  await vi.waitFor(() => {
    if (!warnings.some((warning) => warning.code === "transcript_poll_stopped"))
      throw new Error("no transcript_poll_stopped warning");
  });
  expect(ptys[0]!.killSignals).toEqual([]);
  await shutdown;
  expect(ptys[0]!.killSignals).toEqual(["SIGTERM"]);
});
