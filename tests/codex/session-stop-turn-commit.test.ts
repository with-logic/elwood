/**
 * A graceful shutdown right after a `Stop`-hook `ready` waits for Codex to commit the
 * turn (PRD §5.7, C-LIFE-13). Codex records `task_complete` only after the hook returns,
 * and a process signaled before then leaves the resumed conversation interrupted.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { type CodexSessionApi, startCodex } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

/** One transcript record line; `turnId` null omits the field. */
function record(type: string, turnId: string | null): string {
  const payload = turnId === null ? { type } : { type, turn_id: turnId };
  return `${JSON.stringify({ type: "event_msg", payload })}\n`;
}

/** A session mid-turn whose rollout Codex has not finished writing. */
async function runningTurn(cwd: string, hooks: Parameters<typeof startCodex>[0]["hooks"] = {}) {
  const path = join(cwd, "rollout.jsonl");
  writeFileSync(path, "");
  const session = await startCodex({ cwd, hooks });
  await becomeReady(session.elwoodSessionId, cwd, { transcript_path: path });
  ptys[0]!.emitData("\u001b[2J\u001b[H• Working (3s • esc to interrupt)\r\n› ");
  await vi.waitFor(() => {
    if (session.status !== "running") throw new Error(`status ${session.status}`);
  });
  return { session, path };
}

/** The `Stop` hook Codex runs when turn-1 ends, before it records the turn's completion. */
function stopHook(session: CodexSessionApi, cwd: string, transcriptPath: string | null) {
  return ptys[0]!.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "Stop",
    session_id: "codex-1",
    cwd,
    model: "gpt-5.3-codex",
    turn_id: "turn-1",
    stop_hook_active: false,
    transcript_path: transcriptPath,
  });
}

/**
 * Ends turn-1 through its `Stop` hook and runs `verb` synchronously from the `ready` it
 * produces, as a host that closes a finished session does. Wrapped, so awaiting this
 * does not also await the shutdown.
 */
async function shutdownAtReady(
  session: CodexSessionApi,
  cwd: string,
  verb: "stop" | "teardown",
  path: string,
): Promise<{ readonly shutdown: Promise<void> }> {
  let shutdown: Promise<void> | undefined;
  session.on("status", (event) => {
    if (event.status === "ready") shutdown ??= session[verb]();
  });
  await stopHook(session, cwd, path);
  if (!shutdown) throw new Error("the Stop hook did not report ready");
  return { shutdown };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test.each([
  ["stop", "SIGTERM"],
  ["teardown", "SIGKILL"],
] as const)("C-LIFE-13 %s at a Stop-hook ready signals Codex only once the turn is committed", async (verb, signal) => {
  installFakes();
  const cwd = tempDir();
  const { session, path } = await runningTurn(cwd);
  const { shutdown } = await shutdownAtReady(session, cwd, verb, path);
  // Another turn's end, and a record that ends no turn, are not this turn's commit.
  appendFileSync(path, record("task_complete", "turn-0"));
  appendFileSync(path, record("token_count", "turn-1"));
  await pause(300);
  expect(ptys[0]!.killSignals).toEqual([]);
  appendFileSync(path, record("task_complete", "turn-1"));
  await shutdown;
  expect(ptys[0]!.killSignals).toEqual([signal]);
});

test("C-LIFE-13 a turn end without a turn id releases the wait", async () => {
  installFakes();
  const cwd = tempDir();
  const { session, path } = await runningTurn(cwd);
  const { shutdown } = await shutdownAtReady(session, cwd, "stop", path);
  await pause(100);
  expect(ptys[0]!.killSignals).toEqual([]);
  appendFileSync(path, record("turn_aborted", null));
  await shutdown;
  expect(ptys[0]!.killSignals).toEqual(["SIGTERM"]);
});

test("C-LIFE-13 a CLI that exits on its own before committing releases the wait", async () => {
  installFakes();
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

// Without a wait, the signal goes out in the same tick as the call.
test.each([
  ["kill forces termination", "kill", true, {}],
  ["a Stop without a transcript path leaves nothing to read", "stop", false, {}],
  [
    "a blocked Stop continues the turn",
    "stop",
    true,
    { Stop: () => ({ decision: "block" as const, reason: "go on" }) },
  ],
] as const)("C-LIFE-13 no commit wait: %s", async (_name, verb, withPath, hooks) => {
  installFakes();
  const cwd = tempDir();
  const { session, path } = await runningTurn(cwd, hooks);
  await stopHook(session, cwd, withPath ? path : null);
  const shutdown = session[verb]();
  expect(ptys[0]!.killSignals).toHaveLength(1);
  await shutdown;
});
