/** Unit coverage for browser dev app log summaries and event shaping. Covers PRD §9 and §10. */

import { describe, expect, test } from "vitest";
import {
  activityEvent,
  hookErrorEvent,
  hookEvent,
  runtimeErrorEvent,
  sessionEvent,
  statusEvent,
  terminalExitEvent,
  warningEvent,
} from "../../src/app/web-events.ts";
import { summarizeHookEvent } from "../../src/app/web-log.ts";
import type {
  ClaudeHookEventFor,
  ElwoodActivityEvent,
  ElwoodWarningEvent,
} from "../../src/index.ts";

describe("browser dev app event helpers", () => {
  test("C-APP-05 summarizes hook events for live logs", () => {
    expect(summarizeHookEvent(hooks.userPromptSubmit())).toBe("hook UserPromptSubmit");
    expect(summarizeHookEvent(hooks.stop("done".repeat(100)))).toContain("hook Stop: ");
    expect(summarizeHookEvent(hooks.subagentStop("reviewer", "sub done"))).toBe(
      "hook SubagentStop reviewer: sub done",
    );
    expect(summarizeHookEvent(hooks.stopFailure("tool_use_rejected", "failed"))).toBe(
      "hook StopFailure tool_use_rejected: failed",
    );
    expect(summarizeHookEvent(hooks.notification("info", "heads up"))).toBe(
      "hook Notification info: heads up",
    );
    expect(summarizeHookEvent(hooks.postCompact("manual", "summary"))).toBe(
      "hook PostCompact: summary",
    );
    expect(
      summarizeHookEvent({
        hook_event_name: "PostCompact",
        session_id: "codex-1",
        cwd: "/tmp/project",
        model: "gpt-5.3-codex",
        turn_id: "turn-1",
        trigger: "manual",
      }),
    ).toBe("hook PostCompact: manual");
  });

  test("C-APP-09 shapes rich structured debugger events", () => {
    expect(sessionEvent({ id: "s1", cwd: "/tmp/project", status: "running" })).toMatchObject({
      kind: "session",
      badge: "SES",
      raw: { id: "s1" },
    });
    expect(statusEvent({ elwoodSessionId: "s1", status: "ready" })).toMatchObject({
      kind: "status",
      tags: ["ready"],
    });
    expect(terminalExitEvent({ elwoodSessionId: "s1", exitCode: 9, signal: 15 })).toMatchObject({
      level: "warn",
      summary: "exit 9 signal 15",
    });
    expect(warningEvent(warning())).toMatchObject({ kind: "warning", badge: "WRN" });
    expect(hookEvent(hooks.stop())).toMatchObject({
      kind: "hook",
      title: "Stop",
    });
    expect(
      hookErrorEvent({
        elwoodSessionId: "s1",
        hookEventName: "Stop",
        category: "timeout",
        message: "timed out",
      }),
    ).toMatchObject({ kind: "hookError", level: "error" });
    expect(
      hookErrorEvent({
        elwoodSessionId: "s1",
        hookEventName: "Stop",
        category: "timeout",
      } as never),
    ).toMatchObject({ summary: "Hook handling failed." });
    expect(runtimeErrorEvent("bad".repeat(100)).summary).toHaveLength(180);
  });

  test("C-APP-09 preserves activity semantics in debugger entries", () => {
    expect(activityEvent(activity("assistant_message"))).toMatchObject({
      title: "Assistant message",
      summary: "body",
    });
    expect(activityEvent(activity("user_message")).title).toBe("User message");
    expect(activityEvent(activity("tool_call")).title).toBe("Tool call: label");
    expect(activityEvent(activity("tool_result")).title).toBe("Tool result: label");
    expect(activityEvent(activity("warning")).level).toBe("warn");
    expect(activityEvent(activity("hook_error")).level).toBe("error");
    expect(activityEvent(activity("status")).level).toBe("success");
    expect(activityEvent(activity("reasoning")).title).toBe("reasoning");
  });
});

// Complete, variant-specific literals — no Partial, no widening cast. Each factory
// returns exactly one ClaudeHookEventFor<name>, so an impossible event/field
// combination (a Notification carrying `compact_summary`, a Stop missing a required
// field) is a compile error at the call site, not silently constructed.
const common = { session_id: "claude-1", cwd: "/tmp/project" } as const;
const hooks = {
  userPromptSubmit: () =>
    ({
      ...common,
      hook_event_name: "UserPromptSubmit",
      prompt: "hi",
    }) satisfies ClaudeHookEventFor<"UserPromptSubmit">,
  stop: (last_assistant_message?: string) =>
    ({
      ...common,
      hook_event_name: "Stop",
      ...(last_assistant_message === undefined ? {} : { last_assistant_message }),
    }) satisfies ClaudeHookEventFor<"Stop">,
  subagentStop: (agent_type: string, last_assistant_message: string) =>
    ({
      ...common,
      hook_event_name: "SubagentStop",
      agent_id: "sub-1",
      agent_type,
      agent_transcript_path: "/tmp/sub.jsonl",
      last_assistant_message,
    }) satisfies ClaudeHookEventFor<"SubagentStop">,
  stopFailure: (error: string, last_assistant_message: string) =>
    ({
      ...common,
      hook_event_name: "StopFailure",
      error,
      last_assistant_message,
    }) satisfies ClaudeHookEventFor<"StopFailure">,
  notification: (notification_type: string, message: string) =>
    ({
      ...common,
      hook_event_name: "Notification",
      notification_type,
      message,
    }) satisfies ClaudeHookEventFor<"Notification">,
  postCompact: (trigger: "manual" | "auto", compact_summary: string) =>
    ({
      ...common,
      hook_event_name: "PostCompact",
      trigger,
      compact_summary,
    }) satisfies ClaudeHookEventFor<"PostCompact">,
} as const;

function activity(kind: ElwoodActivityEvent["kind"]): ElwoodActivityEvent {
  return {
    elwoodSessionId: "s1",
    agent: "codex",
    source: "transcript",
    kind,
    label: "label",
    text: "body",
    raw: { kind },
  };
}

function warning(): ElwoodWarningEvent {
  return {
    elwoodSessionId: "s1",
    agent: "codex",
    source: "terminal",
    code: "mcp_server_not_logged_in",
    severity: "warning",
    message: "linear is not logged in",
    mcpServerName: "linear",
    recoveryCommand: "codex mcp login linear",
    raw: "raw",
  };
}
