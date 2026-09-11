/**
 * Execution coverage for bounded Codex update-prompt ownership (PRD §5.5/C-CLI-05).
 */

import { describe, expect, test } from "vitest";
import { executeRun } from "../../src/cli/run/index.ts";
import { AsyncOutputSink } from "../../src/cli/stream.ts";
import type { EffectiveRunRequest } from "../../src/cli/types.ts";
import { codexUpdateAttentionGraceMs } from "../../src/cli/update-attention.ts";
import { effectiveRequest } from "./main-fakes.ts";
import { FakeCliSession, FakeClock, FakeSignals, MemoryWriter } from "./run-fakes.ts";

const request = (overrides: Partial<EffectiveRunRequest> = {}): EffectiveRunRequest =>
  effectiveRequest({ output: "json", ...overrides });

function io() {
  const stdout = new MemoryWriter();
  return {
    stdout,
    value: { stdout: new AsyncOutputSink(stdout), stderr: new AsyncOutputSink(new MemoryWriter()) },
  };
}

function blockOnUpdate(session: FakeCliSession): Promise<void> {
  return session.start().then(() => {
    session.underlying.status = "blocked";
    session.emitActivity({ label: "codex-update-prompt" });
    return new Promise(() => {});
  });
}

describe("executeRun Codex update attention", () => {
  test("C-CLI-05 fails and cleans up after the bounded automation grace", async () => {
    const session = new FakeCliSession();
    session.setupWork = blockOnUpdate;
    const clock = new FakeClock();
    const streams = io();
    const running = executeRun(request(), session, streams.value, {
      signals: new FakeSignals(),
      clock,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(clock.delays).toEqual([codexUpdateAttentionGraceMs]);
    clock.fire();
    await expect(running).resolves.toBe(1);
    expect(JSON.parse(streams.stdout.value).error).toEqual({
      code: "blocked_prompt",
      message: "Blocked prompt: codex-update-prompt.",
    });
    expect(session.kills).toBe(1);
    expect(session.teardowns).toBe(1);
  });

  test("C-CLI-05 successful update automation cancels the grace period", async () => {
    const session = new FakeCliSession();
    session.setupWork = async (current) => {
      await current.start();
      current.underlying.status = "blocked";
      current.emitActivity({ label: "codex-update-prompt" });
      current.emitActivity({ kind: "startup_prompt", label: "update" });
      current.underlying.status = "ready";
      current.emitter.emit("status", { elwoodSessionId: "s1", status: "ready" });
    };
    const clock = new FakeClock();
    const streams = io();
    await expect(
      executeRun(request(), session, streams.value, { signals: new FakeSignals(), clock }),
    ).resolves.toBe(0);
    expect(clock.handler).toBeUndefined();
    expect(session.kills).toBe(0);
  });

  test("C-CLI-05 rejected update automation fails immediately", async () => {
    const session = new FakeCliSession();
    session.setupWork = async (current) => {
      await current.start();
      current.underlying.status = "blocked";
      current.emitActivity({ label: "codex-update-prompt" });
      current.emitter.emit("warning", {
        elwoodSessionId: "s1",
        agent: "codex",
        source: "terminal",
        code: "startup_prompt_write_failed",
        severity: "warning",
        message: "safe write failed",
        label: "update",
        raw: "startup_prompt_write_failed label=update",
      });
      await new Promise(() => {});
    };
    const streams = io();
    await expect(
      executeRun(request(), session, streams.value, { signals: new FakeSignals() }),
    ).resolves.toBe(1);
    expect(JSON.parse(streams.stdout.value).error.code).toBe("blocked_prompt");
    expect(session.kills).toBe(1);
  });

  test("C-CLI-05 a stale update replay after readiness remains automation-owned", async () => {
    const session = new FakeCliSession();
    session.setupWork = async (current) => {
      await current.start();
      current.emitActivity({ label: "codex-update-prompt" });
    };
    const clock = new FakeClock();
    const streams = io();
    await expect(
      executeRun(request(), session, streams.value, { signals: new FakeSignals(), clock }),
    ).resolves.toBe(0);
    expect(clock.delays).toEqual([]);
  });

  test("C-CLI-05 another agent cannot claim Codex update automation ownership", async () => {
    const session = new FakeCliSession();
    session.setupWork = async (current) => {
      await current.start();
      current.emitActivity({ label: "codex-update-prompt" });
    };
    const streams = io();
    await expect(
      executeRun(request({ agent: "claude" }), session, streams.value, {
        signals: new FakeSignals(),
      }),
    ).resolves.toBe(1);
    expect(session.kills).toBe(1);
  });
});
