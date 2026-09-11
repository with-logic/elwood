/**
 * End-to-end fake-session execution tests for the headless run core (PRD §12A.2-§12A.3).
 */

import { describe, expect, test } from "vitest";
import { executeRun } from "../../src/cli/run/index.ts";
import { AsyncOutputSink } from "../../src/cli/stream.ts";
import type { EffectiveRunRequest } from "../../src/cli/types.ts";
import { elwoodError } from "../../src/core/errors.ts";
import { FakeCliSession, FakeSignals, MemoryWriter } from "./run-fakes.ts";

const request = (overrides: Partial<EffectiveRunRequest> = {}): EffectiveRunRequest => ({
  agent: "codex",
  output: "text",
  outputExplicit: false,
  trust: true,
  highTrust: false,
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

  test.each([
    { resumable: false, expected: null, case: "unpersisted" },
    { resumable: true, expected: "s1", case: "resumable" },
  ])("C-CLI-08 failed startup reports a $case kept identity truthfully", async (example) => {
    const session = new FakeCliSession();
    session.resumable = example.resumable;
    session.setupWork = () => Promise.reject(elwoodError("codex_start_failed", "Could not start."));
    const streams = io();
    await executeRun(request({ keep: true, output: "json" }), session, streams.value, {
      signals: new FakeSignals(),
    });
    expect(JSON.parse(streams.stdout.value)).toMatchObject({
      sessionId: example.expected,
      cleanup: { action: "preserve", status: "succeeded" },
    });
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

  test.each([
    { agent: "claude" as const, trust: true, label: "workspace_trust" },
    { agent: "codex" as const, trust: false, label: "hook_trust" },
    { agent: "codex" as const, trust: false, label: "codex-update-prompt" },
  ])("C-CLI-05 auto-owned $label attention waits for its responder", async (owned) => {
    const session = new FakeCliSession();
    session.setupWork = async (current) => {
      await current.start();
      current.emitActivity({ label: owned.label });
    };
    const streams = io();
    expect(
      await executeRun(
        request({ agent: owned.agent, trust: owned.trust }),
        session,
        streams.value,
        {
          signals: new FakeSignals(),
        },
      ),
    ).toBe(0);
    expect(streams.stdout.value).toBe("ok\n");
    expect(session.kills).toBe(0);
  });

  test("C-CLI-05 no-trust leaves workspace trust blocking", async () => {
    const session = new FakeCliSession();
    session.setupWork = async (current) => {
      await current.start();
      current.emitActivity({ label: "workspace_trust" });
    };
    const streams = io();
    expect(
      await executeRun(request({ agent: "claude", trust: false }), session, streams.value, {
        signals: new FakeSignals(),
      }),
    ).toBe(1);
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

  test("C-CLI-11/C-CLI-12 JSONL receives normalized status and warning without rich activity", async () => {
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
