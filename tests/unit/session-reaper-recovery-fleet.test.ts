/** Fifty live owners confirm through production coalescing/admission/parser (C-LIFE-14). */
import { setImmediate } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import { BACKGROUND_REAP_RETRY_WINDOW_MS } from "../../src/runtime/shutdown/detached-sweep/background.ts";
import {
  admitNativeProcessRead,
  createAdmittedPsRunner,
} from "../../src/runtime/shutdown/native-read-admission.ts";
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
  let clock = 0;
  const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const foreground = gates.map((gate) => admitNativeProcessRead(10_000, () => gate.promise));
  const native = vi.fn(async () => ({
    stdout: "11 1 11 S Sun Oct 25 22:00:00 2026 unrelated 11\n",
  }));
  const runner = createAdmittedPsRunner(native);
  const read = createUnreferencedProcessTableReader(runner);
  const fake = scripted([]);
  const owners = Array.from({ length: 50 }, (_, index) => {
    const leader = 10_001_000 + index;
    let reads = 0;
    return new SessionReaper(leader, {
      ...fake.ops,
      listProcesses: (ms) => {
        reads += 1;
        if (reads === 1)
          return Promise.resolve(
            fake.asRead([
              { ...leaderRow, pid: leader, pgid: leader },
              hook(10_002_000 + index, { ppid: leader }),
            ]),
          );
        if (reads === 2) return Promise.reject(errno("EIO"));
        return read(ms);
      },
      listProcessesUnreferenced: () => Promise.resolve([hook(10_002_000 + index, { ppid: 1 })]),
      stopGroup: (group) => {
        if (group === 10_002_000 + index) throw errno("EIO");
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
    const confirmed = Promise.all(
      owners.map((owner) => owner.reapAndThrowOnDetachedSweepFailure()),
    );
    await setImmediate();
    expect(native).not.toHaveBeenCalled();
    gates[0]!.resolve();
    await confirmed;
    expect(native).toHaveBeenCalledOnce();
    expect(fake.calls.filter((call) => call.startsWith("kill "))).toHaveLength(50);
    expect(fake.calls.filter((call) => call.startsWith("stop "))).toHaveLength(50);
  } finally {
    for (const gate of gates) gate.resolve();
    await Promise.all(foreground);
    now.mockRestore();
  }
});
