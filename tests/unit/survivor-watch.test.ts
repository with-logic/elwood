/**
 * A graceful stop's watch for the detached descendants its leader leaves (PRD §5.3 and
 * §9.4, C-LIFE-10): it records from the read before the SIGTERM until it is finished, then
 * reaps what it recorded only if `leaderExited` reports the exit, and hands the outcome,
 * a failure included, to `keep` once. Injected process operations only.
 */

import { describe, expect, test, vi } from "vitest";
import { watchSurvivors } from "../../src/runtime/shutdown/detached-sweep/survivor-watch.ts";
import type { ProcessEntry } from "../../src/runtime/shutdown/process-table.ts";
import { errno, hook, LEADER, leaderRow, scripted } from "../helpers/scripted-process-tree.ts";

/** The leader's tree as the read before the SIGTERM shows it, then as its exit leaves it. */
const tree = [leaderRow, hook(5002), hook(5003, { ppid: 5002, pgid: 5002 })];
const orphaned: readonly ProcessEntry[] = [
  hook(5002, { ppid: 1 }),
  hook(5003, { ppid: 5002, pgid: 5002 }),
];

describe("C-LIFE-10 a graceful stop's survivor watch", () => {
  test("a leader with no reapable group id is not watched", async () => {
    const { ops, calls } = scripted([orphaned]);
    const keep = vi.fn<Parameters<typeof watchSurvivors>[3]>();
    const watch = watchSurvivors(undefined, ops, () => true, keep);
    await watch.firstRead;
    await watch.finish();
    expect(calls).toEqual([]);
    expect(keep).not.toHaveBeenCalled();
  });

  test("a leader not seen to exit is not reaped after", async () => {
    const { ops, calls } = scripted([tree]);
    const keep = vi.fn<Parameters<typeof watchSurvivors>[3]>();
    const watch = watchSurvivors(LEADER, ops, () => false, keep);
    await watch.firstRead;
    await watch.finish();
    expect(new Set(calls)).toEqual(new Set(["list"]));
    expect(keep).not.toHaveBeenCalled();
  });

  test("once the leader is gone, the recorded survivors are reaped and the outcome kept", async () => {
    const { ops, calls } = scripted([tree, orphaned]);
    const keep = vi.fn<Parameters<typeof watchSurvivors>[3]>();
    const watch = watchSurvivors(LEADER, ops, () => true, keep);
    await watch.firstRead;
    await watch.finish();
    expect(calls.join(", ")).toBe("list, list, stop 5002, list, list, kill 5002");
    expect(keep).toHaveBeenCalledOnce();
    expect(keep.mock.calls[0]?.[0]).toBeUndefined(); // No failure, handed with its record.
    const record = keep.mock.calls[0]?.[1];
    expect(record?.pids).toEqual([5002, 5003]);
    expect(record?.survivors(orphaned)).toEqual(orphaned);
  });

  test("a reap that fails hands its failure to keep, once", async () => {
    const refusingStop = () => {
      throw errno("EPERM");
    };
    const { ops } = scripted([tree, orphaned], { stopGroup: refusingStop });
    const keep = vi.fn<Parameters<typeof watchSurvivors>[3]>();
    const watch = watchSurvivors(LEADER, ops, () => true, keep);
    await watch.firstRead;
    await watch.finish();
    expect(keep).toHaveBeenCalledOnce();
    expect(keep.mock.calls[0]?.[0]).toMatchObject({
      message:
        "Could not reap detached descendants: could not stop a live descendant group (EPERM)",
      processGroupIds: [5002],
    });
    const record = keep.mock.calls[0]?.[1];
    expect(record?.pids).toEqual([5002, 5003]);
    expect(record?.survivors(orphaned)).toEqual(orphaned);
  });
});
