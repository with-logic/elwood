/** Snapshot indexes reuse work without reusing daemon decisions (PRD §5.3, C-LIFE-10). */
import { expect, test } from "vitest";
import { survivorAndDescendantGroups } from "../../src/runtime/shutdown/detached-sweep/survivor-groups.ts";
import { processIndex } from "../../src/runtime/shutdown/process-index.ts";
import { processIndexBase } from "../../src/runtime/shutdown/process-index-base.ts";
import type { ProcessEntry, PsRunner } from "../../src/runtime/shutdown/process-table.ts";
import {
  daemonScope,
  listProcessTableMarkingDaemon,
} from "../../src/runtime/shutdown/shared-daemon.ts";
import { hook } from "../helpers/scripted-process-tree.ts";

const DAEMON = "/tmp/home/packages/app-server-daemon/bin/codex";

test("C-LIFE-10 shared snapshot indexes are reused while marking remains caller-specific", async () => {
  let iterations = 0;
  const rows = [
    hook(5000, { ppid: 1, name: "codex" }),
    hook(5001, { ppid: 5000, name: "codex" }),
    hook(6000, { ppid: 1, name: "codex" }),
    hook(6001, { ppid: 6000, name: "codex" }),
  ].map((row) => Object.freeze(row));
  const table: readonly ProcessEntry[] = Object.freeze(
    new Proxy(rows, {
      get(target, key, receiver) {
        if (key === Symbol.iterator || key === "map" || key === "filter") iterations += 1;
        return Reflect.get(target, key, receiver);
      },
    }),
  );
  const probes: number[] = [];
  const run: PsRunner = (_file, args) => {
    probes.push(Number(args.at(-1)));
    return Promise.resolve({ stdout: DAEMON });
  };
  const mark = (pid: number) =>
    listProcessTableMarkingDaemon(
      3_000,
      daemonScope(new Set([pid])),
      () => Promise.resolve(table),
      run,
    );
  const first = await mark(5000);
  const traversals = iterations;
  const second = await mark(6000);
  // Each caller still builds its own marked output; only the snapshot index is reused.
  expect(iterations).toBe(traversals + 1);
  const { byPid, children } = processIndexBase(table);
  const repeated = processIndexBase(table);
  expect(repeated.byPid).toBe(byPid);
  expect(repeated.children).toBe(children);
  expect(first.filter((row) => row.shared).map((row) => row.pid)).toEqual([5000, 5001]);
  expect(second.filter((row) => row.shared).map((row) => row.pid)).toEqual([6000, 6001]);
  expect(table.every((row) => !row.shared)).toBe(true);
  expect(first[2]).toBe(table[2]);
  expect(second[0]).toBe(table[0]);
  expect(probes.sort()).toEqual([5000, 5001, 6000, 6001]);

  const next = Object.freeze(rows.filter((row) => row.pid !== 5000));
  const absentRoot = await listProcessTableMarkingDaemon(
    3_000,
    daemonScope(new Set([5000])),
    () => Promise.resolve(next),
    run,
  );
  expect(absentRoot.filter((row) => row.shared).map((row) => row.pid)).toEqual([5001]);
});

test("C-LIFE-10 daemon and survivor consumers share a lazy snapshot base", async () => {
  let groupReads = 0;
  const root = Object.freeze({
    ...hook(5002),
    get pgid() {
      groupReads += 1;
      return 5002;
    },
  });
  const child = Object.freeze(hook(5003, { ppid: 5002 }));
  const table = Object.freeze([root, child]);
  const base = processIndexBase(table);
  expect(groupReads).toBe(0);
  const raw = await listProcessTableMarkingDaemon(
    3_000,
    daemonScope(new Set([5002])),
    () => Promise.resolve(table),
    () => {
      throw new Error("non-daemon snapshot must not probe paths");
    },
  );
  expect(raw).toBe(table);
  const groups = survivorAndDescendantGroups([root], raw, 9000);
  expect([...groups.groups.keys()]).toEqual([5002, 5003]);
  const survivors = processIndex(raw);
  expect(survivors.byPid).toBe(base.byPid);
  expect(survivors.children).toBe(base.children);
  expect(survivors.byGroup.get(5002)).toEqual([root]);
  const reads = groupReads;
  expect(processIndex(raw)).toBe(survivors);
  expect(processIndex(raw).byGroup).toBe(survivors.byGroup);
  expect(groupReads).toBe(reads);
});
