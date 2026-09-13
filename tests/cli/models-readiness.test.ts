/** Discovery waits for semantic readiness under every lifecycle exit (C-CLI-26). */
import { expect, test, vi } from "vitest";
import { executeModels } from "../../src/cli/models/index.ts";
import { AsyncOutputSink } from "../../src/cli/stream.ts";
import type { ElwoodSessionStatus } from "../../src/core/types.ts";
import { effectiveRequest } from "./main-fakes.ts";
import { FakeCliSession, FakeClock, FakeSignals, MemoryWriter } from "./run-fakes.ts";

test.each([
  "ready",
  "timeout",
  "interrupt",
  "blocked",
])("C-CLI-26 discovery waits through startup: %s", async (ending) => {
  const session = new FakeCliSession();
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const clock = new FakeClock();
  const signals = new FakeSignals();
  let release!: (status: ElwoodSessionStatus) => void;
  session.underlying.waitForStatus = (match) => {
    expect(match("starting")).toBe(false);
    expect(match("ready")).toBe(true);
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const list = vi.spyOn(session.underlying, "listModels");
  const result = executeModels(
    effectiveRequest({ timeoutMs: 50, trust: false }),
    session,
    { stdout: new AsyncOutputSink(stdout), stderr: new AsyncOutputSink(stderr) },
    { signals, clock },
  );
  await new Promise((resolve) => setImmediate(resolve));
  expect(list).not.toHaveBeenCalled();
  if (ending === "ready") release("ready");
  if (ending === "timeout") {
    clock.value = 60;
    clock.fire();
  }
  if (ending === "interrupt") signals.emit();
  if (ending === "blocked") session.emitActivity({ kind: "attention", label: "permission" });
  expect(await result).toBe({ ready: 0, timeout: 124, interrupt: 130, blocked: 1 }[ending]);
  expect(list).toHaveBeenCalledTimes(ending === "ready" ? 1 : 0);
  release("ready");
  await new Promise((resolve) => setImmediate(resolve));
  expect(list).toHaveBeenCalledTimes(ending === "ready" ? 1 : 0);
  expect(session.teardowns).toBe(1);
});
