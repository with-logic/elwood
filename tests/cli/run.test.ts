/**
 * End-to-end fake-session execution tests for the headless run core (PRD §12A.2-§12A.3).
 */

import { describe, expect, test } from "vitest";
import { executeRun } from "../../src/cli/run.ts";
import { AsyncOutputSink } from "../../src/cli/stream.ts";
import type { EffectiveRunRequest } from "../../src/cli/types.ts";
import { elwoodError } from "../../src/core/errors.ts";
import { FakeCliSession, FakeSignals, MemoryWriter } from "./run-fakes.ts";

const request = (overrides: Partial<EffectiveRunRequest> = {}): EffectiveRunRequest => ({
  agent: "codex",
  output: "text",
  outputExplicit: false,
  trust: true,
  stateDir: "/state",
  verbose: false,
  stream: false,
  cwd: "/work",
  images: [{ path: "/work/a.png" }],
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

describe("executeRun", () => {
  test("C-CLI-08/C-CLI-10 successful new turn tears down and returns final text", async () => {
    const session = new FakeCliSession();
    const streams = io();
    expect(
      await executeRun(request(), session, streams.value, { signals: new FakeSignals() }),
    ).toBe(0);
    expect(streams.stdout.value).toBe("ok\n");
    expect(streams.stderr.value).toBe("");
    expect(session.teardowns).toBe(1);
    expect(session.turnOptions?.images).toEqual([{ path: "/work/a.png" }]);
    expect(session.emitter.hasListeners("activity")).toBe(false);
  });

  test("C-CLI-09 startup errors become one JSON error and still clean up", async () => {
    const session = new FakeCliSession();
    session.setupWork = () => Promise.reject(elwoodError("codex_start_failed", "Could not start."));
    const streams = io();
    expect(
      await executeRun(request({ output: "json" }), session, streams.value, {
        signals: new FakeSignals(),
      }),
    ).toBe(1);
    expect(JSON.parse(streams.stdout.value)).toMatchObject({
      type: "error",
      error: { code: "codex_start_failed", message: "Could not start." },
      response: "",
    });
    expect(session.teardowns).toBe(1);
  });

  test("C-CLI-05 blocking attention stops before user submission", async () => {
    const session = new FakeCliSession();
    session.setupWork = async (current) => {
      await current.start();
      current.emitActivity({ label: "claude-permission-dialog" });
    };
    const streams = io();
    expect(
      await executeRun(request({ output: "json" }), session, streams.value, {
        signals: new FakeSignals(),
      }),
    ).toBe(1);
    expect(JSON.parse(streams.stdout.value).error).toEqual({
      code: "blocked_prompt",
      message: "Blocked prompt: claude-permission-dialog.",
    });
    expect(session.turnOptions).toBeUndefined();
    expect(session.kills).toBe(1);
  });

  test("C-CLI-09 premature exit retains partial JSONL response", async () => {
    const session = new FakeCliSession();
    session.events = [{ type: "text", text: "partial" }];
    session.streamWork = (current) => {
      current.emitter.emit("terminal:exit", { elwoodSessionId: "s1", exitCode: 0 });
      return Promise.resolve();
    };
    const streams = io();
    expect(
      await executeRun(request({ output: "jsonl" }), session, streams.value, {
        signals: new FakeSignals(),
      }),
    ).toBe(1);
    const records = streams.stdout.value
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.at(-1)).toMatchObject({
      type: "error",
      response: "partial",
      error: { code: "agent_exited" },
    });
  });

  test("JSONL receives normalized status and warning without rich activity", async () => {
    const session = new FakeCliSession();
    session.streamWork = (current) => {
      current.emitActivity({ kind: "hook", label: "Stop" });
      current.emitter.emit("status", { elwoodSessionId: "s1", status: "ready" });
      current.emitter.emit("warning", {
        elwoodSessionId: "s1",
        agent: "codex",
        source: "lifecycle",
        code: "version_unparseable",
        severity: "warning",
        message: "warning",
        raw: "raw",
      });
      return Promise.resolve();
    };
    const streams = io();
    await executeRun(request({ output: "jsonl" }), session, streams.value, {
      signals: new FakeSignals(),
    });
    expect(streams.stdout.value).toContain('"type":"status"');
    expect(streams.stdout.value).toContain('"type":"warning"');
  });
});
