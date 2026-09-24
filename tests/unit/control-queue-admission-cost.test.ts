/** Parked backlog selection scales with new work, not old blocked input (PRD §5.9). */
import { expect, test } from "vitest";
import { ControlAdmissions } from "../../src/core/control-queue/admission.ts";
import { ControlQueue } from "../../src/core/control-queue/index.ts";

const loop = { origin: { kind: "loop", loopId: "loop" } } as const;

test("C-LOOP-08 10,000 parked turn followers are checked once and a later control passes", async () => {
  let visits = 0;
  const has = ControlAdmissions.prototype.has;
  ControlAdmissions.prototype.has = function (operation) {
    visits += 1;
    return has.call(this, operation);
  };
  const gate = Promise.withResolvers<void>();
  const writes: string[] = [];
  const queue = new ControlQueue(
    (text) => {
      writes.push(text);
      return Promise.resolve();
    },
    () => new Error("closed"),
    () => undefined,
    undefined,
    undefined,
    undefined,
    (origin) =>
      origin.kind === "loop" ? { ready: gate.promise, run: (work) => work() } : undefined,
  );
  try {
    queue.markReady();
    const pending = [queue.send("loop", "message", undefined, loop).catch(() => undefined)];
    for (let index = 0; index < 10_000; index += 1) {
      pending.push(queue.send("follower", "message").catch(() => undefined));
    }
    const blockedVisits = visits;
    await queue.send("picker", "list_models");
    expect(writes).toEqual(["picker"]);
    queue.close();
    await Promise.all(pending);
    expect(blockedVisits).toBeLessThanOrEqual(10_001);
  } finally {
    queue.close();
    ControlAdmissions.prototype.has = has;
  }
});
