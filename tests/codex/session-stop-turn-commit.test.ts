/**
 * A graceful shutdown right after a `Stop`-hook `ready` waits for Codex to record the
 * turn (PRD §5.7, C-LIFE-13). Codex records `task_complete` only after the hook returns,
 * and a process signaled before then leaves the resumed conversation interrupted.
 */
import { afterEach, expect, test, vi } from "vitest";
import { CodexTranscriptWatcher } from "../../src/codex/transcript/index.ts";
import type { CodexSessionApi, ElwoodWarningEvent } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import {
  appendRecord,
  endStarted,
  expiringCommitWait,
  runningTurn,
  shutdownAtReady,
  stopHook,
  tracked,
  transcriptReads,
  unboundedCommitWait,
} from "./turn-commit-harness.ts";

afterEach(async () => {
  await endStarted();
  vi.restoreAllMocks();
  resetFakes();
});

type WarningCode = ElwoodWarningEvent["code"];

/** The codes of every warning `session` emits from now on. */
function warningCodes(session: CodexSessionApi): WarningCode[] {
  const codes: WarningCode[] = [];
  session.on("warning", (event) => codes.push(event.code));
  return codes;
}

/** Makes the next transcript scan fail, which finishes the watcher: no record can end
 * the wait after it. */
function failScans(): void {
  vi.spyOn(CodexTranscriptWatcher.prototype, "scan").mockImplementationOnce(() => {
    throw new Error("scan failed");
  });
}

test.each([
  ["stop", "SIGTERM"],
  ["teardown", "SIGKILL"],
] as const)("C-LIFE-13 %s at a Stop-hook ready signals Codex once the turn is recorded, closing input and loops at once", async (verb, signal) => {
  installFakes();
  unboundedCommitWait();
  const cwd = tempDir();
  const { session, path } = await runningTurn(cwd);
  const warnings = warningCodes(session);
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
  await transcriptReads(2);
  expect(ptys[0]!.killSignals).toEqual([]);
  expect(ptys[0]!.writes).toHaveLength(writes);
  // Polled from the transcript: with the bound lifted, nothing else can end the wait.
  appendRecord(path, "task_complete", "turn-1");
  await shutdown;
  expect(ptys[0]!.killSignals).toEqual([signal]);
  expect(warnings).not.toContain("turn_commit_wait_expired");
});

test("C-LIFE-13 a CLI that exits on its own before recording the turn releases the wait", async () => {
  installFakes();
  unboundedCommitWait();
  const cwd = tempDir();
  const { session, path } = await runningTurn(cwd);
  const warnings = warningCodes(session);
  const { shutdown } = await shutdownAtReady(session, cwd, "stop", path);
  await transcriptReads(1); // The wait is under way.
  ptys[0]!.emitExit({ exitCode: 0 });
  await shutdown;
  // Nothing was signaled: the exit was the CLI's own.
  expect(ptys[0]!.killSignals).toEqual([]);
  expect(session.status).toBe("exited");
  expect(warnings).not.toContain("turn_commit_wait_expired");
});

test("C-LIFE-13 a transcript read failure during the wait is reported, and the bound ends it with a warning", async () => {
  installFakes();
  const cwd = tempDir();
  const { session, path } = await runningTurn(cwd);
  const warnings: ElwoodWarningEvent[] = [];
  // One trace of the warning against the PTY's signals: the warning comes first.
  const signalsAtWarning: number[] = [];
  session.on("warning", (event) => {
    warnings.push(event);
    if (event.code === "turn_commit_wait_expired")
      signalsAtWarning.push(ptys[0]!.killSignals.length);
  });
  const activityCodes: unknown[] = [];
  session.on("activity", (event) => {
    if (event.kind === "warning") activityCodes.push(event.label);
  });
  const { shutdown } = await shutdownAtReady(session, cwd, "stop", path);
  failScans();
  // Contained, not an uncaught exception from the wait's poll timer.
  await vi.waitFor(
    () => {
      if (!warnings.some((warning) => warning.code === "transcript_poll_stopped"))
        throw new Error("no transcript_poll_stopped warning");
    },
    { timeout: 5_000 }, // the wait's poll runs on a real timer
  );
  expect(ptys[0]!.killSignals).toEqual([]);
  await shutdown;
  expect(ptys[0]!.killSignals).toEqual(["SIGTERM"]);
  expect(signalsAtWarning).toEqual([0]);
  // Content-free: a fixed token, no transcript or turn content.
  expect(warnings.find((warning) => warning.code === "turn_commit_wait_expired")).toMatchObject({
    agent: "codex",
    source: "lifecycle",
    message: expect.stringContaining("within 2 seconds of the shutdown request"),
    raw: "turn_commit_wait_expired",
  });
  expect(activityCodes).toContain("turn_commit_wait_expired");
});

test("C-LIFE-13 overlapping stop and teardown share one wait and report its expiry once", async () => {
  installFakes();
  const cwd = tempDir();
  const { session, path } = await runningTurn(cwd);
  const warnings = warningCodes(session);
  // Every commit wait runs out at once, so a second wait of its own would also expire and warn.
  expiringCommitWait();
  // A real CLI takes a while to exit once signaled.
  const pty = ptys[0]!;
  vi.spyOn(pty, "kill").mockImplementation((signal = "SIGTERM") => pty.killSignals.push(signal));
  let shutdowns: Promise<void>[] | undefined;
  session.on("status", (event) => {
    if (event.status === "ready") shutdowns ??= [session.stop(), session.teardown()].map(tracked);
  });
  await stopHook(session, cwd, path);
  await vi.waitFor(() => expect(pty.killSignals).not.toEqual([]), { timeout: 5_000 });
  pty.emitExit({ exitCode: 0 });
  await Promise.allSettled(shutdowns ?? []);
  expect(warnings.filter((code) => code === "turn_commit_wait_expired")).toHaveLength(1);
});
