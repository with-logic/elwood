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
    listProcessesUnreferenced: () => Promise.reject(errno("EIO")),
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

test.each([
  "stop",
  "kill",
  "teardown",
] as const)("C-LIFE-14 %s succeeds after the cached graceful owner's original-group KILL recovers", async (verb) => {
  installFakes();
  const fake = scripted([]);
  const background = Promise.withResolvers<void>();
  let kills = 0;
  let gone = false;
  setProcessTreeOpsForTests({
    ...fake.ops,
    killGroup: (group) => {
      fake.calls.push(`kill ${group}`);
      kills += 1;
      if (kills === 1) throw errno("EIO");
      gone = true;
    },
    listProcesses: () => {
      const leader = ptys.at(-1)!.pid;
      return Promise.resolve(
        fake.asRead(gone ? [] : [{ ...leaderRow, pid: leader, pgid: leader }]),
      );
    },
    listProcessesUnreferenced: async () => {
      await background.promise;
      const leader = ptys.at(-1)!.pid;
      return fake.asRead(gone ? [] : [{ ...leaderRow, pid: leader, pgid: leader }]);
    },
  });
  const session = await startClaude({ cwd: tempDir() });
  const pty = ptys.at(-1)!;
  await expect(session.stop()).rejects.toMatchObject({
    code: "termination_failed",
    details: { errno: "EIO" },
  });
  expect(kills).toBe(1);
  background.resolve();
  await vi.waitFor(() => expect(gone).toBe(true));
  // The recovery controller confirms disappearance on its next automatic pass.
  await vi.waitFor(() => expect(session[verb]()).resolves.toBeUndefined(), { timeout: 3000 });
  expect(pty.killSignals).toEqual(["SIGTERM"]);
  expect(kills).toBe(2);
  await session.teardown();
});
