/** Fifty live owners confirm through production coalescing/admission/parser (C-LIFE-14). */
import { setImmediate } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import {
  BACKGROUND_REAP_RETRY_MS,
  BACKGROUND_REAP_RETRY_WINDOW_MS,
} from "../../src/runtime/shutdown/detached-sweep/background.ts";
import { admitNativeProcessRead } from "../../src/runtime/shutdown/native-read-admission.ts";
import { SessionReaper } from "../../src/runtime/shutdown/reap-tree.ts";
import { createUnreferencedProcessTableReader } from "../../src/runtime/shutdown/unreferenced-read.ts";
import {
  errno,
  hook,
  leaderNeverExits,
  leaderRow,
  scripted,
  useScriptedHost,
} from "../helpers/scripted-process-tree.ts";

useScriptedHost();
test("C-LIFE-14 fifty expired session owners share a scan behind admitted foreground work", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let clock = 0;
  const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const foreground = gates.map((gate) => admitNativeProcessRead(10_000, () => gate.promise));
  const native = vi.fn(async () => ({
    stdout: "11 1 11 S Sun Oct 25 22:00:00 2026 unrelated 11\n",
  }));
  const read = createUnreferencedProcessTableReader(native);
  const fake = scripted([]);
  const owners = Array.from({ length: 50 }, (_, index) => {
    const leader = 10_001_000 + index;
    let recovering = false;
    return new SessionReaper(leader, {
      ...fake.ops,
      listProcesses: (ms) => {
        if (!recovering)
          return Promise.resolve(
            fake.asRead([
              { ...leaderRow, pid: leader, pgid: leader },
              hook(10_002_000 + index, { ppid: leader }),
            ]),
          );
        return read(ms);
      },
      listProcessesUnreferenced: () => Promise.resolve([hook(10_002_000 + index, { ppid: 1 })]),
      killGroup: (group) => {
        if (group === 10_002_000 + index) {
          recovering = true;
          throw errno("EIO");
        }
        fake.ops.killGroup(group);
      },
      stopGroup: (group) => {
        if (recovering && group === 10_002_000 + index) throw errno("EIO");
        fake.ops.stopGroup(group);
      },
    });
  });
  try {
    await Promise.all(
      owners.map((owner) => expect(owner.sweepDetached(leaderNeverExits)).rejects.toThrow()),
    );
    for (const owner of owners) owner.reap();
    clock = BACKGROUND_REAP_RETRY_WINDOW_MS;
    const confirmed = Promise.all(owners.map((owner) => owner.reapOrConfirmAndThrowIfUnresolved()));
    await setImmediate();
    expect(native).not.toHaveBeenCalled();
    gates[0]!.resolve();
    await confirmed;
    expect(native).toHaveBeenCalledOnce();
    expect(fake.calls.filter((call) => call.startsWith("kill "))).toHaveLength(50);
    expect(fake.calls.filter((call) => call.startsWith("stop "))).toHaveLength(100);
  } finally {
    try {
      for (const gate of gates) gate.resolve();
      await Promise.all(foreground);
      clock = BACKGROUND_REAP_RETRY_WINDOW_MS;
      await vi.advanceTimersByTimeAsync(BACKGROUND_REAP_RETRY_MS);
      await setImmediate();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      now.mockRestore();
      vi.useRealTimers();
    }
  }
});
