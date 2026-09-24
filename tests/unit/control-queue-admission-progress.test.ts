/** Pending queue admission preserves independent controls and event-loop progress (PRD §5.9). */
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { ControlQueue } from "../../src/core/control-queue/index.ts";

class ProgressQueue extends ControlQueue {
  drains = 0;
  protected override drain(): void {
    this.drains += 1;
    // Bound a broken microtask loop before it can starve the test runner's timer.
    if (this.drains > 20) throw new Error("admission drain did not stop");
    super.drain();
  }
}

test("C-LOOP-08 one rescan lets queued controls pass pending admission without starving timers or I/O", async () => {
  const gate = Promise.withResolvers<void>();
  const occupied = Promise.withResolvers<void>();
  const writes: string[] = [];
  let admissions = 0;
  let settled = false;
  const queue = new ProgressQueue(
    (input) => {
      writes.push(input);
      return Promise.resolve();
    },
    () => new Error("closed"),
    () => undefined,
    undefined,
    undefined,
    undefined,
    (origin) => {
      if (origin.kind !== "loop") return undefined;
      admissions += 1;
      return { ready: gate.promise, run: (work) => work() };
    },
  );
  queue.markReady();
  const active = queue.runExclusive("list_models", () => occupied.promise);
  const pending = queue
    .send("loop", "message", undefined, {
      origin: { kind: "loop", loopId: "pending" },
    })
    .then(() => {
      settled = true;
    });
  const crossing = queue.send("crossing", "list_models");
  occupied.resolve();
  await active;
  try {
    await delay(0);
    const drains = queue.drains;
    expect((await readFile(new URL(import.meta.url))).byteLength).toBeGreaterThan(0);
    await delay(0);
    expect(queue.drains).toBe(drains);
    expect(admissions).toBe(1);
    expect(settled).toBe(false);
    expect(writes).toEqual(["crossing"]);
  } finally {
    gate.resolve();
    await Promise.all([pending, crossing]);
    queue.close();
  }
  expect(writes).toEqual(["crossing", "loop"]);
});
