/**
 * Client-message dispatch for the browser dev app: session lifecycle.
 * Covers PRD §11 (C-APP-01..08): explicit per-type dispatch, serialized session
 * mutation, and stop/kill/teardown handling.
 */

import { describe, expect, test } from "vitest";
import type { SharedSession } from "../../src/app/agent-runtime.ts";
import { dispatchClientMessage } from "../../src/app/web-dispatch.ts";
import { fakeSession, frame, harnessWith, start } from "./web-dispatch-helpers.ts";

describe("web dispatch", () => {
  test("C-APP-01 start launches a session and announces it", async () => {
    const harness = harnessWith();
    await dispatchClientMessage(
      harness.deps,
      frame({ type: "start", agent: "codex", cwd: "/w", cols: 80, rows: 24 }),
      harness.report,
    );
    expect(harness.launches).toHaveLength(1);
    expect(harness.launches[0]?.agent).toBe("codex");
    expect(harness.broadcasts).toContainEqual({
      type: "session",
      id: "s1",
      cwd: "/w",
      status: "running",
    });
    expect(harness.broadcasts.some((m) => m.type === "event")).toBe(true);
  });

  test("C-APP-02 start forwards optional stateDir and elwoodSessionId", async () => {
    const harness = harnessWith();
    await dispatchClientMessage(
      harness.deps,
      frame({
        type: "start",
        cwd: "/w",
        cols: 80,
        rows: 24,
        stateDir: "/s",
        elwoodSessionId: "resume-me",
      }),
      harness.report,
    );
    expect(harness.launches[0]).toMatchObject({ stateDir: "/s", elwoodSessionId: "resume-me" });
  });

  test("C-APP-05 start installs live hook handlers that swallow their log writes", async () => {
    const harness = harnessWith();
    await dispatchClientMessage(
      harness.deps,
      frame({ type: "start", agent: "claude", cwd: "/w", cols: 80, rows: 24 }),
      harness.report,
    );
    const hooks = harness.launches[0]?.hooks as Record<string, (event: unknown) => unknown>;
    // Invoking a generated handler exercises its no-op log write.
    expect(
      hooks["Stop"]?.({ hook_event_name: "Stop", session_id: "s", cwd: "/w" }),
    ).toBeUndefined();
  });

  test("C-APP-08 concurrent starts serialize: the first session is torn down, not leaked", async () => {
    const first = fakeSession("s1");
    const second = fakeSession("s2");
    const queued = [first, second];
    const harness = harnessWith(() => Promise.resolve(queued.shift() as SharedSession));
    const a = dispatchClientMessage(
      harness.deps,
      frame({ type: "start", cwd: "/w", cols: 80, rows: 24 }),
      harness.report,
    );
    const b = dispatchClientMessage(
      harness.deps,
      frame({ type: "start", cwd: "/w", cols: 80, rows: 24 }),
      harness.report,
    );
    await Promise.all([a, b]);
    expect(harness.deps.slot.session).toBe(second);
    expect(first.teardownCount).toBe(1);
    expect(second.teardownCount).toBe(0);
  });

  test("C-APP-07 a slow data-plane op does not head-of-line block a later frame", async () => {
    // A slow sendPrompt must NOT hold the slot mutex: a later keys frame has to reach
    // the session (which has its own control queue) before the prompt resolves.
    const session = fakeSession("s1");
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    session.sendPrompt = (value: string) => {
      session.prompts.push(value);
      return promptGate;
    };
    const harness = harnessWith(() => Promise.resolve(session));
    await start(harness);
    const prompt = dispatchClientMessage(
      harness.deps,
      frame({ type: "prompt", value: "slow" }),
      harness.report,
    );
    // The keys frame resolves while the prompt is still parked — no HOL blocking.
    await dispatchClientMessage(harness.deps, frame({ type: "keys", value: "x" }), harness.report);
    expect(session.keys).toEqual(["x"]);
    releasePrompt();
    await prompt;
    expect(session.prompts).toEqual(["slow"]);
  });

  test("C-APP-04 C-APP-07 prompt, keys, and resize reach the active session", async () => {
    const session = fakeSession("s1");
    const harness = harnessWith(() => Promise.resolve(session));
    await start(harness);
    await dispatchClientMessage(
      harness.deps,
      frame({ type: "prompt", value: "hi" }),
      harness.report,
    );
    await dispatchClientMessage(harness.deps, frame({ type: "keys", value: "" }), harness.report);
    await dispatchClientMessage(
      harness.deps,
      frame({ type: "resize", cols: 100, rows: 40 }),
      harness.report,
    );
    expect(session.prompts).toEqual(["hi"]);
    expect(session.keys).toEqual([""]);
    expect(session.sizes).toEqual([{ cols: 100, rows: 40 }]);
  });

  test("C-APP-08 stop and kill close the active session and clear the slot", async () => {
    const session = fakeSession("s1");
    const harness = harnessWith(() => Promise.resolve(session));
    await start(harness);
    await dispatchClientMessage(harness.deps, frame({ type: "stop" }), harness.report);
    expect(session.stopped).toBe(1);
    expect(harness.deps.slot.session).toBeNull();

    const killed = fakeSession("s2");
    const killHarness = harnessWith(() => Promise.resolve(killed), harness.deps.slot);
    await start(killHarness);
    await dispatchClientMessage(killHarness.deps, frame({ type: "kill" }), killHarness.report);
    expect(killed.killed).toBe(1);
    expect(killHarness.deps.slot.session).toBeNull();
  });

  test("C-APP-08 teardown requires the explicit teardown type", async () => {
    const session = fakeSession("s1");
    const harness = harnessWith(() => Promise.resolve(session));
    await start(harness);
    await dispatchClientMessage(harness.deps, frame({ type: "teardown" }), harness.report);
    expect(session.teardownCount).toBe(1);
    expect(harness.deps.slot.session).toBeNull();
  });
});
