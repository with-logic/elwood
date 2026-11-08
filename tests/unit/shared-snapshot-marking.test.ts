/** Shared native snapshots keep daemon marks local to each caller (PRD §5.3, C-LIFE-10). */
import { expect, test, vi } from "vitest";
import { createAdmittedPsRunner } from "../../src/runtime/shutdown/native-read-admission.ts";
import type { ProcessEntry, PsRunner } from "../../src/runtime/shutdown/process-table.ts";
import {
  daemonScope,
  listProcessTableMarkingDaemon,
} from "../../src/runtime/shutdown/shared-daemon.ts";
import { createUnreferencedProcessTableReader } from "../../src/runtime/shutdown/unreferenced-read.ts";

const DAEMON = "/tmp/owned-home/packages/app-server-daemon/releases/0.164.0/bin/codex";

test("C-LIFE-10 two daemon scopes mark one parsed shared snapshot independently", async () => {
  const stdout = [
    [5000, 4000],
    [5010, 5000],
    [5011, 5010],
    [7000, 4000],
    [7010, 7000],
    [7011, 7010],
  ]
    .map(([pid, ppid]) => `${pid} ${ppid} ${pid} S Sun Oct 25 22:00:00 2026 codex ${pid}\n`)
    .join("");
  const nativeScan = vi.fn<PsRunner>(() => Promise.resolve({ stdout }));
  const sharedRead = createUnreferencedProcessTableReader(nativeScan);
  const snapshots: (readonly ProcessEntry[])[] = [];
  const list = async (timeoutMs: number) => {
    const table = await sharedRead(timeoutMs);
    snapshots.push(table);
    return table;
  };
  const probes: number[] = [];
  const readPath = createAdmittedPsRunner((_file, args) => {
    const pid = Number(args.at(-1));
    probes.push(pid);
    return Promise.resolve({
      stdout: [5010, 7010].includes(pid) ? DAEMON : "/tmp/standalone/codex",
    });
  });
  const [first, second] = await Promise.all([
    listProcessTableMarkingDaemon(2_000, daemonScope(new Set([5000])), list, readPath),
    listProcessTableMarkingDaemon(2_000, daemonScope(new Set([7000])), list, readPath),
  ]);
  const marked = (table: readonly ProcessEntry[]) =>
    table.filter((row) => row.shared).map((row) => row.pid);
  expect(nativeScan).toHaveBeenCalledOnce();
  expect(snapshots).toHaveLength(2);
  expect(snapshots[0]).toBe(snapshots[1]);
  expect(marked(first)).toEqual([5010]);
  expect(marked(second)).toEqual([7010]);
  expect(snapshots.flat().every((row) => !row.shared)).toBe(true);
  expect(probes.sort()).toEqual([5010, 5011, 7010, 7011]);
});
