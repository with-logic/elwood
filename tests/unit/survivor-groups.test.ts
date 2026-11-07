/** Combined survivor traversal preserves ownership and stays linear (C-LIFE-10). */
import { expect, test } from "vitest";
import { survivorAndDescendantGroups } from "../../src/runtime/shutdown/detached-sweep/survivor-groups.ts";
import { hook, useScriptedHost } from "../helpers/scripted-process-tree.ts";

useScriptedHost();

// Allows one index build and two full traversals, but rejects per-record rebuilds.
const MAX_SHARED_PID_INSPECTIONS_PER_ROW = 8;

test("C-LIFE-10 combined roots retain cross-group parent anchors and skip daemon subtrees", () => {
  const root = hook(5002, { ppid: 5003 });
  const peer = hook(5003, { ppid: 5002, pgid: 5002 });
  const child = hook(5004, { ppid: 5003 });
  const secondRoot = hook(5020, { ppid: 1 });
  const secondChild = hook(5021, { ppid: 5020 });
  const zombie = hook(5008, { ppid: 5003, zombie: true });
  const table = [
    hook(process.pid, { ppid: 1, pgid: 4000 }),
    root,
    peer,
    child,
    secondRoot,
    secondChild,
    hook(5005, { ppid: 5004, pgid: 5004 }),
    hook(5006, { ppid: 5003, shared: true }),
    hook(5007, { ppid: 5006 }),
    zombie,
    hook(5009, { ppid: 5008 }),
    hook(5010, { ppid: 5003, pgid: 1 }),
    hook(5011, { ppid: 5003, pgid: 4000 }),
    hook(5012, { ppid: 5002, pgid: 5004 }),
  ];
  const found = survivorAndDescendantGroups([root, secondRoot], table, process.pid);
  expect(found.roots).toEqual(new Set([5002, 5020]));
  expect(found.groups).toEqual(
    new Map([
      [5002, new Set()],
      [5020, new Set()],
      [5021, new Set([secondRoot])],
      [5004, new Set([peer, root])],
      [5009, new Set([zombie])],
    ]),
  );
  expect(
    survivorAndDescendantGroups([table[0]!, hook(2, { pgid: 1 })], table, process.pid).groups,
  ).toEqual(new Map());
});

test("C-LIFE-10 a shared member in a survivor group does not expose its children", () => {
  const root = hook(5002, { ppid: 1 });
  const daemon = hook(5003, { pgid: 5002, shared: true });
  const zombie = hook(5004, { pgid: 5002, zombie: true });
  expect(
    survivorAndDescendantGroups(
      [root],
      [root, daemon, zombie, hook(5005, { ppid: 5003 })],
      process.pid,
    ).groups,
  ).toEqual(new Map([[5002, new Set()]]));
});

test("C-LIFE-10 one immutable read shares its indexes across every survivor record", () => {
  let inspected = 0;
  const rows = Array.from({ length: 2000 }, (_, index) => {
    const pid = 6000 + index;
    const row = hook(pid, { ppid: index === 0 ? 1 : pid - 1, pgid: 6000 });
    Object.defineProperty(row, "pid", {
      get: () => {
        inspected += 1;
        return pid;
      },
    });
    return row;
  });
  const survivors = rows.slice(-100);
  inspected = 0;
  const expected = new Map([[6000, new Set()]]);
  expect(survivorAndDescendantGroups(survivors, rows, process.pid).groups).toEqual(expected);
  const firstReadCost = inspected;
  expect(survivorAndDescendantGroups(survivors, rows, process.pid).groups).toEqual(expected);
  expect(inspected - firstReadCost).toBeLessThan(firstReadCost);
  expect(inspected).toBeLessThanOrEqual(rows.length * MAX_SHARED_PID_INSPECTIONS_PER_ROW);
});
