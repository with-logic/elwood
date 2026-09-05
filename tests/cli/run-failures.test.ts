/**
 * Timeout, cleanup, credential, and output-failure execution tests (PRD §12A.2-§12A.3).
 */

import { describe, expect, test } from "vitest";
import { executeRun } from "../../src/cli/run.ts";
import { AsyncOutputSink } from "../../src/cli/stream.ts";
import type { EffectiveRunRequest } from "../../src/cli/types.ts";
import { registerPrivateOutputSecrets } from "../../src/core/private-output-secrets.ts";
import { FakeCliSession, FakeClock, FakeSignals, MemoryWriter } from "./run-fakes.ts";

const request = (overrides: Partial<EffectiveRunRequest> = {}): EffectiveRunRequest => ({
  agent: "codex",
  output: "text",
  outputExplicit: false,
  trust: true,
  stateDir: "/state",
  verbose: false,
  stream: false,
  cwd: "/work",
  images: [],
  prompt: "go",
  keep: false,
  ephemeral: false,
  sandbox: "workspace-write",
  approvalPolicy: "never",
  ...overrides,
});

function io(stdout = new MemoryWriter(), stderr = new MemoryWriter()) {
  return {
    value: { stdout: new AsyncOutputSink(stdout), stderr: new AsyncOutputSink(stderr) },
    stdout,
    stderr,
  };
}

describe("executeRun failure boundaries", () => {
  test("C-CLI-09 cleanup failure keeps response and changes success to failure", async () => {
    const session = new FakeCliSession();
    session.cleanupError = new Error("private cleanup detail");
    const streams = io();
    expect(
      await executeRun(request({ keep: true }), session, streams.value, {
        signals: new FakeSignals(),
      }),
    ).toBe(1);
    expect(streams.stdout.value).toBe("ok\n");
    expect(streams.stderr.value).toBe("elwood: cleanup_failed: Cleanup failed.\n");
  });

  test("C-CLI-12 runtime credentials are redacted from the response", async () => {
    const session = new FakeCliSession();
    registerPrivateOutputSecrets(session.underlying, ["bridge-token"]);
    session.events = [{ type: "text", text: "saw bridge-token" }];
    const streams = io();
    await executeRun(request(), session, streams.value, { signals: new FakeSignals() });
    expect(streams.stdout.value).toBe("saw [REDACTED]\n");
  });

  test("C-CLI-07 deadline covers pending setup and exits 124", async () => {
    const session = new FakeCliSession();
    session.setupWork = () => new Promise(() => {});
    const clock = new FakeClock();
    const streams = io();
    const running = executeRun(request({ timeoutMs: 5 }), session, streams.value, {
      signals: new FakeSignals(),
      clock,
    });
    await Promise.resolve();
    clock.value = 5;
    clock.fire();
    await expect(running).resolves.toBe(124);
    expect(session.teardowns).toBe(1);
  });

  test("a setup that owns no live session still executes through the facade", async () => {
    const session = new FakeCliSession();
    session.setupWork = () => Promise.resolve();
    const streams = io();
    await executeRun(request(), session, streams.value, { signals: new FakeSignals() });
    expect(streams.stdout.value).toBe("ok\n");
  });

  test("C-CLI-12 streamed EPIPE cleans up and exits successfully", async () => {
    const session = new FakeCliSession();
    const stdout = new MemoryWriter();
    stdout.failAt = 1;
    const streams = io(stdout);
    expect(
      await executeRun(request({ stream: true }), session, streams.value, {
        signals: new FakeSignals(),
      }),
    ).toBe(0);
    expect(session.interrupts).toBe(1);
    expect(session.teardowns).toBe(1);
  });

  test("progress output failure becomes the terminal primary error", async () => {
    const session = new FakeCliSession();
    session.streamWork = (current) => {
      current.emitter.emit("status", { elwoodSessionId: "s1", status: "ready" });
      return Promise.resolve();
    };
    const streams = io();
    streams.stderr.write = (_value, callback) => {
      callback(new Error("stderr failed"));
      return true;
    };
    expect(
      await executeRun(request({ output: "json", verbose: true }), session, streams.value, {
        signals: new FakeSignals(),
      }),
    ).toBe(1);
    expect(JSON.parse(streams.stdout.value).error.code).toBe("runtime_error");
  });

  test("terminal output failure is contained after cleanup", async () => {
    const session = new FakeCliSession();
    const stdout = new MemoryWriter();
    stdout.write = (_value, callback) => {
      callback(new Error("stdout failed"));
      return true;
    };
    const streams = io(stdout);
    expect(
      await executeRun(request(), session, streams.value, { signals: new FakeSignals() }),
    ).toBe(1);
    expect(session.teardowns).toBe(1);
  });
});
