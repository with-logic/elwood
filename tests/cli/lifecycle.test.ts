/**
 * Central CLI outcome, signal, deadline, and cleanup conformance tests (PRD §12A.2).
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { CliLifecycle } from "../../src/cli/lifecycle/index.ts";
import { cleanupAction } from "../../src/cli/lifecycle/outcome.ts";
import { elwoodError } from "../../src/core/errors.ts";
import { effectiveRequest as request } from "./main-fakes.ts";
import { FakeCliSession, FakeClock, FakeSignals } from "./run-fakes.ts";

afterEach(() => vi.useRealTimers());

describe("CliLifecycle", () => {
  test("C-CLI-08 cleanup policy covers new, keep, resume, and ephemeral", () => {
    expect(cleanupAction(request())).toBe("teardown");
    expect(cleanupAction(request({ keep: true }))).toBe("preserve");
    expect(cleanupAction(request({ resume: "s1" }))).toBe("preserve");
    expect(cleanupAction(request({ resume: "s1", ephemeral: true }))).toBe("teardown");
  });

  test("C-CLI-07 first SIGINT interrupts and repeated SIGINT force-kills", async () => {
    const session = new FakeCliSession();
    const signals = new FakeSignals();
    const lifecycle = new CliLifecycle(request(), session, signals, new FakeClock());
    lifecycle.start();
    signals.emit();
    expect(session.started).toBe(false);
    lifecycle.beginLaunch();
    await session.start();
    signals.emit();
    await Promise.resolve();
    expect(lifecycle.failure).toMatchObject({ code: "interrupted", exitCode: 130 });
    expect(session.interrupts).toBe(0);
    expect(session.kills).toBe(1);
    await lifecycle.cleanup();
    await lifecycle.cleanup();
    expect(session.teardowns).toBe(1);
    lifecycle.dispose();
    expect(signals.unbound).toBe(true);
  });

  test("C-CLI-07 first SIGINT after launch requests interrupt and contains control failure", async () => {
    const session = new FakeCliSession();
    session.interrupt = () => {
      session.interrupts += 1;
      return Promise.reject(new Error("interrupt failed"));
    };
    const signals = new FakeSignals();
    const lifecycle = new CliLifecycle(request(), session, signals, new FakeClock());
    lifecycle.start();
    lifecycle.beginLaunch();
    signals.emit();
    await Promise.resolve();
    await Promise.resolve();
    expect(lifecycle.failure?.code).toBe("interrupted");
    expect(session.interrupts).toBe(1);
  });

  test("C-CLI-07 absolute deadline slices long timers and interrupts at expiry", async () => {
    const session = new FakeCliSession();
    const clock = new FakeClock();
    const timeoutMs = 2_147_483_657;
    const lifecycle = new CliLifecycle(request({ timeoutMs }), session, new FakeSignals(), clock);
    lifecycle.beginLaunch();
    await session.start();
    lifecycle.start();
    expect(clock.delays).toEqual([2_147_483_647]);
    clock.value = 2_147_483_647;
    clock.fire();
    expect(clock.delays).toEqual([2_147_483_647, 10]);
    clock.value = timeoutMs;
    clock.fire();
    await Promise.resolve();
    expect(lifecycle.failure).toMatchObject({ code: "timeout", exitCode: 124 });
    expect(session.interrupts).toBe(1);
    clock.value = -1;
    expect(lifecycle.durationMs()).toBe(0);
    lifecycle.dispose();
  });

  test("C-CLI-09 primary outcomes survive later failures and consumer closure", async () => {
    const session = new FakeCliSession();
    const lifecycle = new CliLifecycle(request(), session, new FakeSignals(), new FakeClock());
    lifecycle.beginLaunch();
    await session.start();
    lifecycle.block("claude-permission-dialog");
    lifecycle.agentExited();
    lifecycle.fail(elwoodError("invalid_image", "bad image"));
    lifecycle.closeConsumer();
    await Promise.resolve();
    expect(lifecycle.failure).toMatchObject({ code: "blocked_prompt" });
    expect(session.kills).toBe(1);
  });

  test("C-CLI-09 cleanup failure is secondary and fresh failure becomes primary", async () => {
    const failed = new FakeCliSession();
    failed.cleanupError = new Error("secret cleanup detail");
    const lifecycle = new CliLifecycle(request({ keep: true }), failed, new FakeSignals());
    lifecycle.start();
    const cleanup = await lifecycle.cleanup();
    lifecycle.agentExited();
    expect(cleanup).toEqual({
      action: "preserve",
      status: "failed",
      error: "Cleanup failed.",
    });
    expect(lifecycle.failure).toMatchObject({ code: "cleanup_failed", exitCode: 1 });
    expect(failed.closes).toBe(1);
    lifecycle.dispose();
  });

  test("C-CLI-12 consumer closure is success and races return either operation or stop", async () => {
    const lifecycle = new CliLifecycle(request(), new FakeCliSession(), new FakeSignals());
    expect(await lifecycle.race(Promise.resolve(3))).toEqual({ completed: true, value: 3 });
    lifecycle.closeConsumer();
    lifecycle.closeConsumer();
    lifecycle.fail(new Error("later"));
    expect(await lifecycle.race(new Promise(() => {}))).toEqual({ completed: false });
    expect(lifecycle.consumerClosed).toBe(true);
    expect(lifecycle.failure).toBeUndefined();
  });

  test("C-CLI-09 blocking and exit cleanup preserve the first primary outcome", async () => {
    const session = new FakeCliSession();
    const lifecycle = new CliLifecycle(request({ keep: true }), session, new FakeSignals());
    lifecycle.beginLaunch();
    await session.start();
    lifecycle.block("dialog");
    lifecycle.block("other");
    lifecycle.agentExited();
    session.cleanupWork = () => lifecycle.agentExited();
    expect(await lifecycle.cleanup()).toEqual({ action: "preserve", status: "succeeded" });
    expect(lifecycle.failure?.code).toBe("blocked_prompt");
  });

  test("C-CLI-07 real clock deadline and already-failed expiry are safe", async () => {
    vi.useFakeTimers();
    const session = new FakeCliSession();
    const lifecycle = new CliLifecycle(request({ timeoutMs: 1 }), session, new FakeSignals());
    lifecycle.start();
    lifecycle.fail(new Error("first"));
    await vi.advanceTimersByTimeAsync(1);
    expect(lifecycle.failure?.code).toBe("runtime_error");
    lifecycle.dispose();

    const clock = new FakeClock();
    const alreadyFailed = new CliLifecycle(
      request({ timeoutMs: 1 }),
      new FakeCliSession(),
      new FakeSignals(),
      clock,
    );
    alreadyFailed.start();
    alreadyFailed.fail(new Error("first"));
    clock.value = 1;
    clock.fire();
    expect(alreadyFailed.failure?.code).toBe("runtime_error");
  });
});
