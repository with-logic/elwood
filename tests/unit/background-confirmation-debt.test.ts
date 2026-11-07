/** Confirmation cannot outlive its budget during synchronous retained-debt work (C-LIFE-10). */
import { afterEach, expect, test, vi } from "vitest";
import {
  BACKGROUND_REAP_RETRY_WINDOW_MS,
  reapInBackground,
} from "../../src/runtime/shutdown/detached-sweep/background.ts";
import { serializedReapQueue } from "../helpers/reap-queue.ts";
import { recordedDescendants } from "../helpers/recorded-descendants.ts";
import { hook, scripted, useScriptedHost } from "../helpers/scripted-process-tree.ts";

useScriptedHost();
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test.each([
  "index",
  "debt",
  "CONT",
  "survivors",
] as const)("C-LIFE-10 expiry during %s stops confirmation without late restoration or resolution", async (phase) => {
  vi.useFakeTimers();
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const queue = serializedReapQueue();
  const gate = Promise.withResolvers<void>();
  const heldQueue = queue(() => gate.promise);
  const rows = [
    hook(5002, { stopped: true, shared: true }),
    hook(5003, { stopped: true, shared: true }),
  ];
  const record = recordedDescendants();
  for (const row of rows) record.resumes.remember([row], row.pgid);
  const deadline = BACKGROUND_REAP_RETRY_WINDOW_MS + 10_000;
  const field = phase === "index" ? "startedAt" : phase === "debt" ? "stopped" : "shared";
  if (phase !== "CONT") {
    const value = rows[0]![field];
    Object.defineProperty(rows[0], field, {
      get: () => {
        clock = deadline;
        return value;
      },
    });
  }
  const restored: number[] = [];
  const recovery = reapInBackground(record, scripted([[]]).ops, queue, {
    ...scripted([]).ops,
    listProcesses: () => Promise.resolve(rows),
    continueGroup: (group) => {
      restored.push(group);
      if (phase === "CONT") clock = deadline;
    },
  });
  clock = BACKGROUND_REAP_RETRY_WINDOW_MS;
  const confirmation = recovery.confirm();
  gate.resolve();
  await heldQueue;
  await confirmation;
  expect(recovery.resolved()).toBe(false);
  expect(restored).toEqual(phase === "CONT" ? [5002] : phase === "survivors" ? [5002, 5003] : []);
  expect(record.resumes.pids).toEqual(phase === "survivors" ? [] : [5002, 5003]);
});
