/**
 * The detached sweep's kill pass (PRD §5.3 and §9.4, C-LIFE-10): every stopped group is
 * SIGKILLed deepest first, a failed kill never skips the rest, and an `EPERM` counts only
 * when a fresh read still shows a live member. Injected process operations only; no real
 * group is signaled here.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  DETACHED_SWEEP_BUDGET_MS,
  sweepDetachedGroups,
} from "../../src/runtime/shutdown/detached-sweep/index.ts";
import {
  errno,
  hook,
  LEADER,
  leaderNeverExits,
  leaderRow,
  scripted,
} from "../helpers/scripted-process-tree.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("C-LIFE-10 detached sweep kill pass", () => {
  test("a failed kill does not stop the rest; each reason is reported once", async () => {
    const attempts: number[] = [];
    const tables = [[leaderRow, hook(5002), hook(5003), hook(5004)], [leaderRow]];
    const { ops } = scripted([tables[0] ?? [], tables[0] ?? [], tables[1] ?? []], {
      killGroup: (pgid) => {
        attempts.push(pgid);
        if (pgid !== 5002) throw Object.assign(new Error("kill exploded"), { code: "not errno" });
      },
    });
    const failure = await sweepDetachedGroups(LEADER, ops, leaderNeverExits);
    expect(attempts).toEqual([5004, 5003, 5002]); // the last succeeds after two failed
    expect(failure?.message).toBe(
      "Could not reap detached descendants: could not kill a signaled descendant group",
    );
    expect(failure).toMatchObject({ processGroupIds: [5004, 5003] });
    expect(failure).not.toHaveProperty("code");
  });

  test("a kill refused because the group holds only zombies is not a failure", async () => {
    const refused = "could not kill a signaled descendant group (EPERM)";
    const refusals = [
      { reread: [leaderRow, hook(5002, { zombie: true })], reasons: undefined },
      { reread: [leaderRow, hook(5002)], reasons: refused }, // a live member is still there
      // No read to show otherwise, and why: after the refusal it was meant to judge.
      { reread: undefined, reasons: `${refused}; process table unreadable (EIO)` },
    ];
    for (const { reread, reasons } of refusals) {
      const { ops, calls, asRead } = scripted([], {
        killGroup: (pgid) => {
          calls.push(`kill ${pgid}`);
          throw errno("EPERM");
        },
        listProcesses: () => {
          calls.push("list");
          if (calls.some((call) => call.startsWith("kill")))
            return reread === undefined ? Promise.reject(errno("EIO")) : Promise.resolve(reread);
          return Promise.resolve(asRead([leaderRow, hook(5002)]));
        },
      });
      const failure = await sweepDetachedGroups(LEADER, ops, leaderNeverExits);
      expect(calls.join(", ")).toBe(
        "stop 5000, list, list, stop 5002, list, list, kill 5002, list",
      );
      expect(failure).toEqual(
        reasons === undefined
          ? undefined
          : expect.objectContaining({
              message: `Could not reap detached descendants: ${reasons}`,
              processGroupIds: [5002],
              code: "EPERM",
            }),
      );
    }
  });

  test("a refused kill with no time left for a confirming read is a failure", async () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const { ops, calls, asRead } = scripted([], {
      killGroup: (pgid) => {
        calls.push(`kill ${pgid}`);
        clock = DETACHED_SWEEP_BUDGET_MS + 1_000; // the kill pass ran past the deadline
        throw errno("EPERM");
      },
      listProcesses: () => {
        calls.push("list");
        clock += 100;
        return Promise.resolve(asRead([leaderRow, hook(5002)]));
      },
    });
    const failure = await sweepDetachedGroups(LEADER, ops, leaderNeverExits);
    expect(failure?.message).toBe(
      "Could not reap detached descendants: could not kill a signaled descendant group (EPERM)",
    );
    expect(calls.at(-1)).toBe("kill 5002"); // no read after the kill
  });
});
