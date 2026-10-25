/**
 * Every path to a graceful shutdown during a Codex `Stop` hook meets the wait for the
 * turn's record, and the paths that must not wait do not (PRD §5.7, C-LIFE-13).
 */
import { afterEach, expect, test, vi } from "vitest";
import type { CodexSessionApi } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import {
  appendRecord,
  pause,
  runningTurn,
  stopHook,
  stopHookUntilClosed,
  unboundedCommitWait,
} from "./turn-commit-harness.ts";

afterEach(() => {
  vi.restoreAllMocks();
  resetFakes();
});

type Observer = (session: CodexSessionApi, stop: () => void) => void;

// Each observer runs before the hook's `ready`, while Codex still waits on the hook.
test.each<[string, Observer]>([
  ["a hook observer", (session, stop) => session.on("hook", stop)],
  [
    "the Stop hook handler",
    (session, stop) =>
      session.on("hook:Stop", () => {
        stop();
        return undefined;
      }),
  ],
  ["an activity observer", (session, stop) => session.on("activity", stop)],
  ["a transcript observer", (session, stop) => session.on("codex:transcript", stop)],
])("C-LIFE-13 a stop from %s during the Stop hook waits for the turn's record", async (_name, observe) => {
  installFakes();
  unboundedCommitWait();
  const cwd = tempDir();
  const { session, path } = await runningTurn(cwd);
  let shutdown: Promise<void> | undefined;
  observe(session, () => {
    shutdown ??= session.stop();
  });
  // The hook-time scan delivers this turn's last committed record to transcript observers.
  appendRecord(path, "agent_message", "turn-1");
  await stopHookUntilClosed(session, cwd, path);
  if (!shutdown) throw new Error("the observer did not stop the session");
  await pause(100);
  expect(ptys[0]!.killSignals).toEqual([]);
  appendRecord(path, "task_complete", "turn-1");
  await shutdown;
  expect(ptys[0]!.killSignals).toEqual(["SIGTERM"]);
});

test("C-LIFE-13 a Stop hook that blocks releases a stop its observer started", async () => {
  installFakes();
  unboundedCommitWait();
  const cwd = tempDir();
  const { session, path } = await runningTurn(cwd, {
    Stop: () => ({ decision: "block" as const, reason: "go on" }),
  });
  let shutdown: Promise<void> | undefined;
  session.on("hook", () => {
    shutdown ??= session.stop();
  });
  // With the bound lifted, only the block can release the stop before the record.
  await stopHookUntilClosed(session, cwd, path);
  await shutdown;
  expect(ptys[0]!.killSignals).toEqual(["SIGTERM"]);
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
