/**
 * Unit coverage for the session shutdown coordinator (PRD §5.3/§9.4, C-LIFE-10):
 * overlapping shutdown calls run the underlying operation at most once per claim,
 * later same-or-lower-level callers JOIN the in-flight run, an escalating call
 * chains AFTER it, signal ownership is tracked independently of lifecycle status so
 * a predecessor that signaled-then-threw never causes a re-signal, and a settled
 * failure is retryable rather than permanently blocking later calls.
 */

import { describe, expect, test } from "vitest";
import {
  type ShutdownContext,
  ShutdownCoordinator,
} from "../../src/runtime/shutdown/coordinator.ts";

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

  test("a concurrent escalation does NOT re-signal after the predecessor signaled then threw", async () => {
    // stop() marks the PTY signaled and then throws before submitting a
    // terminal status. A concurrent kill() escalation must observe `alreadySignaled`
    // and NOT signal the (possibly recycled) PID again — it may still reap/cleanup.
    const coordinator = new ShutdownCoordinator();
    const signals: string[] = [];
    const stopping = coordinator.run("stop", (ctx: ShutdownContext) => {
      ctx.markSignaled();
      signals.push("stop-signal");
      return Promise.reject(new Error("stop threw after signaling"));
    });
    const killing = coordinator.run("kill", (ctx: ShutdownContext) => {
      if (!ctx.alreadySignaled) signals.push("kill-signal"); // must be skipped
      return Promise.resolve();
    });
    await expect(stopping).rejects.toThrow("stop threw after signaling");
    await killing;
    expect(signals).toEqual(["stop-signal"]); // signaled exactly once, by stop
  });

  test("a settled failure is retryable: a later call runs a fresh op and does not re-signal", async () => {
    // A failed teardown must not leave every later call joined to the old
    // rejected promise. Once it settles, a later call runs a FRESH operation that
    // retries reap/cleanup, and — because the PTY was already signaled — never
    // re-signals it.
    const coordinator = new ShutdownCoordinator();
    let attempts = 0;
    const signals: string[] = [];
    const op = (ctx: ShutdownContext) => {
      attempts += 1;
      if (!ctx.alreadySignaled) {
        ctx.markSignaled();
        signals.push("signal");
      }
      if (attempts === 1) return Promise.reject(new Error("first reap failed"));
      return Promise.resolve();
    };
    await expect(coordinator.run("teardown", op)).rejects.toThrow("first reap failed");
    await coordinator.run("teardown", op); // retry: fresh op, succeeds
    expect(attempts).toBe(2); // the old rejected promise did not permanently block it
    expect(signals).toEqual(["signal"]); // retry reaps/cleans but does not re-signal
  });
});
