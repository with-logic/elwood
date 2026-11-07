/** Public lifecycle awaits expired retained confirmation (PRD §9.4, C-LIFE-14). */
import { afterEach, expect, test, vi } from "vitest";
import { startClaude } from "../../src/index.ts";
import { BACKGROUND_REAP_RETRY_WINDOW_MS } from "../../src/runtime/shutdown/detached-sweep/background.ts";
import { setProcessTreeOpsForTests } from "../../src/runtime/shutdown/process-tree-ops.ts";
import { errno, hook, leaderRow, scripted } from "../helpers/scripted-process-tree.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
  resetFakes();
});

test.each([
  "stop",
  "kill",
  "teardown",
] as const)("C-LIFE-14 %s retries retained failure without re-signaling", async (verb) => {
  installFakes();
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const fake = scripted([]);
  let reads = 0;
  const confirmation = Promise.withResolvers<[]>();
  setProcessTreeOpsForTests({
    ...fake.ops,
    listProcesses: () => {
      reads += 1;
      if (reads === 2) return Promise.reject(errno("EIO"));
      if (reads > 2) return confirmation.promise;
      const leader = ptys.at(-1)!.pid;
      return Promise.resolve(
        fake.asRead([
          { ...leaderRow, pid: leader, pgid: leader },
          hook(10_000_002, { ppid: leader }),
        ]),
      );
    },
    listProcessesUnreferenced: () => Promise.resolve([hook(10_000_002, { ppid: 1 })]),
    stopGroup: (group) => {
      if (group === 10_000_002) throw errno("EIO");
      fake.ops.stopGroup(group);
    },
  });
  const session = await startClaude({ cwd: tempDir() });
  const pty = ptys.at(-1)!;
  await expect(session.kill()).rejects.toMatchObject({ code: "termination_failed" });
  const signals = [...pty.killSignals];
  clock = BACKGROUND_REAP_RETRY_WINDOW_MS;
  let settled = false;
  const retry = session[verb]().then(
    () => {
      settled = true;
      return undefined;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  await vi.waitFor(() => expect(reads).toBe(3));
  expect(settled).toBe(false);
  confirmation.resolve([]);
  expect(await retry).toBeUndefined();
  expect(pty.killSignals).toEqual(signals);
  expect(fake.calls.filter((call) => call === `kill ${pty.pid}`)).toHaveLength(1);
  await session.teardown();
});
