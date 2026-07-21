/**
 * Client-message dispatch for the browser dev app: error handling and fan-out.
 * Covers PRD §11 (C-APP-05, C-APP-08, C-APP-09): reject-not-teardown handling of
 * bad frames and structured event fan-out from wired session events.
 */

import { describe, expect, test } from "vitest";
import { dispatchClientMessage } from "../../src/app/web-dispatch.ts";
import type { ServerMessage } from "../../src/app/web-messages.ts";
import { fakeSession, frame, harnessWith, start } from "./web-dispatch-helpers.ts";

describe("web dispatch errors and events", () => {
  test("C-APP-08 an unknown type is rejected as a runtime error, not a teardown", async () => {
    const session = fakeSession("s1");
    const harness = harnessWith(() => Promise.resolve(session));
    await start(harness);
    await dispatchClientMessage(harness.deps, '{"type":"tearwdown"}', harness.report);
    expect(session.teardownCount).toBe(0);
    expect(harness.deps.slot.session).toBe(session);
    expect(harness.reports.at(-1)).toMatchObject({ type: "event" });
  });

  test("C-APP-08 a prompt with no active session reports a runtime error", async () => {
    const harness = harnessWith();
    await dispatchClientMessage(
      harness.deps,
      frame({ type: "prompt", value: "hi" }),
      harness.report,
    );
    const entry = harness.reports.at(-1);
    expect(entry?.type).toBe("event");
    if (entry?.type === "event") expect(entry.entry.summary).toContain("No Elwood session");
  });

  test("C-APP-08 a non-Error rejection is reported with its string value", async () => {
    const harness = harnessWith(() => Promise.reject("nope"));
    await dispatchClientMessage(
      harness.deps,
      frame({ type: "start", cwd: "/w", cols: 80, rows: 24 }),
      harness.report,
    );
    const entry = harness.reports.at(-1);
    if (entry?.type === "event") expect(entry.entry.raw).toEqual({ value: "nope" });
  });

  test("C-APP-05 C-APP-09 wired session events broadcast structured debugger entries", async () => {
    const session = fakeSession("s1");
    const harness = harnessWith(() => Promise.resolve(session));
    await start(harness);
    session.emit("terminal:data", { elwoodSessionId: "s1", data: "screen" });
    session.emit("terminal:exit", { elwoodSessionId: "s1", exitCode: 0 });
    session.emit("status", { elwoodSessionId: "s1", status: "ready" });
    session.emit("activity", {
      elwoodSessionId: "s1",
      agent: "codex",
      source: "transcript",
      kind: "reasoning",
      label: "thinking",
    });
    session.emit("warning", {
      elwoodSessionId: "s1",
      agent: "codex",
      source: "terminal",
      code: "mcp_server_not_logged_in",
      severity: "warning",
      message: "linear is not logged in",
      raw: "raw",
    } as never);
    session.emit("hook", { hook_event_name: "Stop", session_id: "s1", cwd: "/w" } as never);
    session.emit("hookError", {
      elwoodSessionId: "s1",
      hookEventName: "Stop",
      category: "timeout",
    });
    expect(harness.broadcasts).toContainEqual({ type: "terminal", data: "screen" });
    expect(harness.broadcasts).toContainEqual({ type: "status", status: "ready" });
    const kinds = harness.broadcasts
      .filter((m): m is Extract<ServerMessage, { type: "event" }> => m.type === "event")
      .map((m) => m.entry.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "session",
        "terminal",
        "status",
        "activity",
        "warning",
        "hook",
        "hookError",
      ]),
    );
  });
});
