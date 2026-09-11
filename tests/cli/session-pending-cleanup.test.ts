/**
 * Pending-launch cleanup coverage for the headless CLI facade.
 * Implements PRD §12A.2 and C-CLI-07/C-CLI-08 without weakening C-API-51.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { executeRun } from "../../src/cli/run/index.ts";
import { HeadlessCliSession } from "../../src/cli/session/index.ts";
import { AsyncOutputSink } from "../../src/cli/stream.ts";
import type { ElwoodAgentSession } from "../../src/core/agent-session.ts";
import * as privateSession from "../../src/state/private-session.ts";
import { FakeUnderlying } from "../unit/simple-fakes.ts";
import { effectiveRequest as request } from "./main-fakes.ts";
import { FakeClock, FakeSignals, MemoryWriter } from "./run-fakes.ts";

afterEach(() => vi.restoreAllMocks());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function output() {
  return {
    stdout: new AsyncOutputSink(new MemoryWriter()),
    stderr: new AsyncOutputSink(new MemoryWriter()),
  };
}

async function settlesWithoutLaunch(promise: Promise<void>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.resolve();
  await Promise.resolve();
  return settled;
}

describe("headless CLI pending-launch cleanup", () => {
  test("C-CLI-07 timeout exits while adapter launch remains unsettled", async () => {
    const pending = request({ timeoutMs: 5 });
    const session = new HeadlessCliSession(
      pending,
      "s1",
      () => new Promise<ElwoodAgentSession>(() => {}),
    );
    const clock = new FakeClock();
    const running = executeRun(pending, session, output(), {
      signals: new FakeSignals(),
      clock,
    });

    await Promise.resolve();
    clock.value = 5;
    clock.fire();

    await expect(running).resolves.toBe(124);
  });

  test("C-CLI-07 SIGINT exits while adapter launch remains unsettled", async () => {
    const pending = request();
    const session = new HeadlessCliSession(
      pending,
      "s1",
      () => new Promise<ElwoodAgentSession>(() => {}),
    );
    const signals = new FakeSignals();
    const running = executeRun(pending, session, output(), { signals });

    await Promise.resolve();
    signals.emit();

    await expect(running).resolves.toBe(130);
  });

  test("C-CLI-07 teardown returns when adapter launch never settles", async () => {
    const session = new HeadlessCliSession(
      request(),
      "s1",
      () => new Promise<ElwoodAgentSession>(() => {}),
    );
    void session.start();

    expect(await settlesWithoutLaunch(session.teardown())).toBe(true);
  });

  test("C-CLI-08 a late launch receives its deferred teardown exactly once", async () => {
    const launch = deferred<ElwoodAgentSession>();
    const live = new FakeUnderlying();
    const teardown = vi.spyOn(live, "teardown").mockRejectedValue(new Error("late failure"));
    const session = new HeadlessCliSession(request(), "s1", () => launch.promise);
    const starting = session.start();
    expect(await settlesWithoutLaunch(session.teardown())).toBe(true);
    launch.resolve(live);
    await expect(starting).resolves.toBe(live);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(teardown).toHaveBeenCalledOnce();
  });

  test("C-CLI-08 preserve cleanup closes a late launch instead of tearing it down", async () => {
    const launch = deferred<ElwoodAgentSession>();
    const live = new FakeUnderlying();
    const session = new HeadlessCliSession(request({ keep: true }), "s1", () => launch.promise);
    vi.spyOn(session, "preservedSessionId").mockReturnValue("s1");
    const starting = session.start();
    expect(await settlesWithoutLaunch(session.close())).toBe(true);
    launch.resolve(live);
    await starting;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(live.stops).toBe(1);
    expect(live.kills).toBe(0);
    expect(live.calls).not.toContain("teardown");
  });

  test("C-CLI-08 preserve cleanup tears down a late launch with no resumable identity", async () => {
    const launch = deferred<ElwoodAgentSession>();
    const live = new FakeUnderlying();
    const session = new HeadlessCliSession(request({ keep: true }), "s1", () => launch.promise);
    const starting = session.start();
    expect(await settlesWithoutLaunch(session.close())).toBe(true);
    launch.resolve(live);
    await starting;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(live.calls).toContain("teardown");
    expect(live.stops).toBe(0);
  });

  test("C-CLI-08 preserve cleanup closes an already-live launch", async () => {
    const live = new FakeUnderlying();
    const session = new HeadlessCliSession(request({ keep: true }), "s1", async () => live);
    await session.start();

    await session.close();

    expect(live.stops).toBe(1);
  });

  test.each([
    "close",
    "teardown",
  ] as const)("C-CLI-09 a late rejected launch is contained after %s cleanup", async (action) => {
    const launch = deferred<ElwoodAgentSession>();
    const session = new HeadlessCliSession(request(), "s1", () => launch.promise);
    if (action === "close") vi.spyOn(session, "preservedSessionId").mockReturnValue("s1");
    const starting = session.start();
    await session[action]();
    launch.reject(new Error("late launch failure"));

    await expect(starting).rejects.toThrow("late launch failure");
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  test("C-CLI-09 a failed late teardown retry is contained", async () => {
    vi.spyOn(privateSession, "removeSessionIdentity").mockImplementation(() => {
      throw new Error("remove failed");
    });
    const launch = deferred<ElwoodAgentSession>();
    const session = new HeadlessCliSession(request(), "s1", () => launch.promise);
    const starting = session.start();

    await expect(session.teardown()).rejects.toThrow("remove failed");
    launch.reject(new Error("late launch failure"));

    await expect(starting).rejects.toThrow("late launch failure");
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
});
