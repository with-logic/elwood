/** Public session and scheduler admission share the bounded queue (C-API-58). */
import { afterEach, expect, test } from "vitest";
import { inputQueueLimits } from "../../src/core/control-queue/budget.ts";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import { LoopScheduler } from "../../src/core/loops/scheduler.ts";
import { startClaude, startCodex } from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";
import { SchedulerHarness } from "./loop-scheduler-harness.ts";

afterEach(() => {
  claude.resetFakes();
  codex.resetFakes();
});

test.each([
  "claude",
  "codex",
] as const)("C-API-58 %s rejects raw backlog but keeps direct interrupt input available", async (agent) => {
  const helper = agent === "claude" ? claude : codex;
  helper.installFakes();
  const session = await (agent === "claude" ? startClaude : startCodex)({ cwd: helper.tempDir() });
  const pty = helper.ptys[0]!;
  const pending = Array.from({ length: inputQueueLimits.operations }, () =>
    session.sendMessage("held").catch((error: unknown) => error),
  );
  let error: unknown;
  const rejected = session.sendMessage("overflow").catch((failure: unknown) => {
    error = failure;
  });
  try {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(error).toMatchObject({ code: "input_queue_full" });
    expect(pty.writes).toEqual([]);
    await session.sendKeys("\u0003");
    expect(pty.writes).toEqual(["\u0003"]);
  } finally {
    await session.teardown();
    await Promise.all([...pending, rejected]);
  }
});

test("C-API-58 loop admission overflow emits failure and rearms without fired telemetry", async () => {
  const harness = new SchedulerHarness();
  const writes: string[] = [];
  const queue = new ControlQueue(
    (text) => {
      writes.push(text);
      return Promise.resolve();
    },
    () => new Error("closed"),
    () => undefined,
  );
  const cancelled = new AbortController();
  const pending = Array.from({ length: inputQueueLimits.operations }, () =>
    queue
      .send("held", "message", undefined, {
        cancel: { signal: cancelled.signal, error: () => new Error("cancelled") },
      })
      .catch(() => undefined),
  );
  harness.submit = (message, loopId, signal) =>
    queue.send(message, "message", undefined, {
      origin: { kind: "loop", loopId },
      cancel: { signal, error: () => new Error("cancelled") },
    });
  const scheduler = new LoopScheduler(harness.options());
  scheduler.start();
  scheduler.ready();
  const loop = scheduler.create({ mode: "fixed", intervalMs: 60_000, message: "loop input" });
  try {
    await harness.clock.advance(60_000 + loop.jitterMs);
    expect(harness.events.at(-1)).toMatchObject({
      kind: "failed",
      code: "loop_submission_failed",
      phase: "submission",
    });
    expect(harness.events.some((event) => event.kind === "fired")).toBe(false);
    expect(scheduler.list()[0]).toMatchObject({ state: "scheduled" });
    expect(writes).toEqual([]);
    cancelled.abort();
    await Promise.all(pending);
    queue.markReady();
    await harness.clock.advance(60_000 + loop.jitterMs);
    expect(writes).toEqual(["loop input"]);
    expect(harness.events.at(-1)).toMatchObject({ kind: "fired", loopId: loop.id });
  } finally {
    scheduler.pause();
    queue.close();
    await Promise.all(pending);
  }
});
