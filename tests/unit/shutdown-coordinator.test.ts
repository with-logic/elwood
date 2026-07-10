/**
 * Unit coverage for the session shutdown coordinator (PRD §5.3/§9.4, C-LIFE-10):
 * overlapping shutdown calls run the underlying operation at most once per claim,
 * later same-or-lower-level callers JOIN the in-flight run, and an escalating call
 * chains AFTER it (so it observes the terminal status the first run produced).
 */

import { describe, expect, test } from "vitest";
import { ShutdownCoordinator } from "../../src/runtime/shutdown-coordinator.ts";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe("C-LIFE-10 shutdown coordinator", () => {
  test("a second SAME-level call joins the in-flight run without a second operation", async () => {
    const coordinator = new ShutdownCoordinator();
    const gate = deferred();
    let runs = 0;
    const op = () => {
      runs += 1;
      return gate.promise;
    };
    const first = coordinator.run("stop", op);
    const second = coordinator.run("stop", op);
    expect(runs).toBe(1); // the join must NOT invoke the operation again
    gate.resolve();
    await Promise.all([first, second]);
    expect(runs).toBe(1);
  });

  test("a LOWER-level call joins a higher in-flight run (kill in-flight, later stop joins)", async () => {
    const coordinator = new ShutdownCoordinator();
    const gate = deferred();
    let runs = 0;
    const op = () => {
      runs += 1;
      return gate.promise;
    };
    const killing = coordinator.run("kill", op);
    const stopping = coordinator.run("stop", op); // lower level: joins, no new op
    expect(runs).toBe(1);
    gate.resolve();
    await Promise.all([killing, stopping]);
    expect(runs).toBe(1);
  });

  test("a HIGHER-level call escalates: it runs AFTER the in-flight run settles", async () => {
    const coordinator = new ShutdownCoordinator();
    const gate = deferred();
    const order: string[] = [];
    const stopping = coordinator.run("stop", () => {
      order.push("stop:start");
      return gate.promise.then(() => void order.push("stop:done"));
    });
    const tearing = coordinator.run("teardown", () => {
      order.push("teardown:start");
      return Promise.resolve();
    });
    expect(order).toEqual(["stop:start"]); // escalation waits for the in-flight run
    gate.resolve();
    await Promise.all([stopping, tearing]);
    expect(order).toEqual(["stop:start", "stop:done", "teardown:start"]);
  });

  test("an escalation still runs after a REJECTED in-flight run (its own failure surfaces)", async () => {
    const coordinator = new ShutdownCoordinator();
    let escalated = false;
    const stopping = coordinator.run("stop", () => Promise.reject(new Error("stop failed")));
    const killing = coordinator.run("kill", () => {
      escalated = true;
      return Promise.resolve();
    });
    await expect(stopping).rejects.toThrow("stop failed");
    await killing;
    expect(escalated).toBe(true);
  });
});
