/**
 * Every path to a graceful shutdown during a Codex `Stop` hook meets the wait for the
 * turn's record, and the paths that must not wait do not (PRD §5.7, C-LIFE-13).
 */
import { afterEach, expect, test, vi } from "vitest";
import type { CodexSessionApi } from "../../src/index.ts";
import { setProcessTreeOpsForTests } from "../../src/runtime/shutdown/reap-tree.ts";
import { quietPtyTree } from "../helpers/quiet-pty-tree.ts";
import { installFakes, ptys, reapedGroups, resetFakes, tempDir } from "./helpers.ts";
import {
  appendRecord,
  endStarted,
  runningTurn,
  stopHook,
  stopHookUntilClosed,
  tracked,
  transcriptReads,
  unboundedCommitWait,
} from "./turn-commit-harness.ts";

afterEach(async () => {
  await endStarted();
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
    shutdown ??= tracked(session.stop());
  });
  // The hook-time scan delivers this turn's last committed record to transcript observers.
  appendRecord(path, "agent_message", "turn-1");
  await stopHookUntilClosed(session, cwd, path);
  if (!shutdown) throw new Error("the observer did not stop the session");
  await transcriptReads(2);
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
    shutdown ??= tracked(session.stop());
  });
  // With the bound lifted, only the block can release the stop before the record.
  await stopHookUntilClosed(session, cwd, path);
  await shutdown;
  expect(ptys[0]!.killSignals).toEqual(["SIGTERM"]);
});

/** Records the group SIGSTOPs and table reads shutdown sends, on a quiet fake tree. */
function groupOperations(): string[] {
  const quiet = quietPtyTree(ptys);
  const operations: string[] = [];
  setProcessTreeOpsForTests({
    ...quiet,
    stopGroup: (pgid) => {
      operations.push(`SIGSTOP -${pgid}`);
      quiet.stopGroup(pgid);
    },
    listProcesses: (timeoutMs, scope) => {
      operations.push("read");
      return quiet.listProcesses(timeoutMs, scope);
    },
    killGroup: (pgid) => void reapedGroups.push(pgid),
  });
  return operations;
}

// Without a wait, shutdown starts in the same tick as the call: for a stop, the table read
// that records the CLI's descendants, which the SIGTERM follows at once (§5.3); for a
// kill, the SIGSTOP of the CLI's group that starts the detached sweep, and its first read.
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
  const operations = groupOperations();
  const cwd = tempDir();
  const { session, path } = await runningTurn(cwd, hooks);
  await stopHook(session, cwd, withPath ? path : null);
  const shutdown = tracked(session[verb]());
  expect([...ptys[0]!.killSignals, ...operations]).toEqual(
    verb === "kill" ? [`SIGSTOP -${ptys[0]!.pid}`, "read"] : ["read"],
  );
  await new Promise((resolve) => setImmediate(resolve));
  expect(ptys[0]!.killSignals).toEqual([verb === "kill" ? "SIGKILL" : "SIGTERM"]);
  await shutdown;
  expect(ptys[0]!.killSignals).toEqual([verb === "kill" ? "SIGKILL" : "SIGTERM"]);
});
