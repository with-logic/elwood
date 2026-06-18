/** Focused unit coverage for browser dev app helpers. Covers PRD §9 and §10. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { clientScript, renderHtml } from "../../src/app/web-assets.ts";
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
import { parseClientMessage, sizeFrom } from "../../src/app/web-messages.ts";
import type { ClaudeHookEvent, ElwoodActivityEvent, ElwoodWarningEvent } from "../../src/index.ts";

describe("browser dev app helpers", () => {
  test("C-APP-08 renders the shell and client script", () => {
    expect(renderHtml("/tmp/project")).toContain('value="/tmp/project"');
    expect(renderHtml("/tmp/project")).toContain('value="codex"');
    expect(renderHtml("/tmp/project")).toContain("/client.js");
    expect(renderHtml('/tmp/"project"')).toContain('value="/tmp/&quot;project&quot;"');
    expect(clientScript()).toContain("new Terminal");
    expect(clientScript()).toContain("agent:");
    expect(clientScript()).toContain('send({ type: "resize"');
    expect(clientScript()).toContain('send({ type: "stop"');
    expect(clientScript()).toContain('send({ type: "teardown"');
  });

  test("C-APP-10 renders structured debugger controls", () => {
    const html = renderHtml("/tmp/project");
    expect(html).toContain('id="events"');
    expect(html).toContain('id="detail-json"');
    expect(html).toContain('data-filter="hook"');
    expect(clientScript()).toContain('if (message.type === "event") addEvent(message.entry)');
    expect(clientScript()).toContain("(entry.tags || []).includes(activeFilter)");
    expect(clientScript()).toContain("function renderDetail");
  });

  test("C-APP-08 parses client messages and terminal sizes", () => {
    expect(parseClientMessage('{"type":"kill"}')).toEqual({ type: "kill" });
    expect(parseClientMessage('{"type":"stop"}')).toEqual({ type: "stop" });
    expect(parseClientMessage('{"type":"start","agent":"codex","cwd":"."}')).toMatchObject({
      agent: "codex",
    });
    expect(sizeFrom({ cols: 120, rows: 40 })).toEqual({ cols: 120, rows: 40 });
    expect(() => parseClientMessage("null")).toThrow("Invalid client message.");
  });

  test("C-APP-08 keeps shutdown handling outside the web server body", () => {
    const source = readFileSync(new URL("../../src/app/web-dev.ts", import.meta.url), "utf8");
    const supervisor = readFileSync(new URL("../../scripts/dev-web.ts", import.meta.url), "utf8");
    expect(source).not.toContain("setRawMode");
    expect(source).not.toContain("process.stdin");
    expect(source).not.toContain("terminal.snapshot");
    expect(source).toContain('active.on("terminal:data"');
    expect(supervisor).toContain('spawn("node"');
  });

  test("C-APP-05 summarizes hook events for live logs", () => {
    expect(summarizeHookEvent(hook({ hook_event_name: "UserPromptSubmit" }))).toBe(
      "hook UserPromptSubmit",
    );
    expect(
      summarizeHookEvent(
        hook({ hook_event_name: "Stop", last_assistant_message: "done".repeat(100) }),
      ),
    ).toContain("hook Stop: ");
    expect(
      summarizeHookEvent(
        hook({
          hook_event_name: "SubagentStop",
          agent_type: "reviewer",
          last_assistant_message: "sub done",
        }),
      ),
    ).toBe("hook SubagentStop reviewer: sub done");
    expect(
      summarizeHookEvent(
        hook({
          hook_event_name: "StopFailure",
          error: "tool_use_rejected",
          last_assistant_message: "failed",
        }),
      ),
    ).toBe("hook StopFailure tool_use_rejected: failed");
    expect(
      summarizeHookEvent(
        hook({
          hook_event_name: "Notification",
          notification_type: "info",
          message: "heads up",
        }),
      ),
    ).toBe("hook Notification info: heads up");
    expect(
      summarizeHookEvent(hook({ hook_event_name: "PostCompact", compact_summary: "summary" })),
    ).toBe("hook PostCompact: summary");
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
    expect(hookEvent(hook({ hook_event_name: "Stop" }))).toMatchObject({
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

function hook(fields: Partial<ClaudeHookEvent>): ClaudeHookEvent {
  return {
    hook_event_name: "Notification",
    session_id: "claude-1",
    cwd: "/tmp/project",
    ...fields,
  } as ClaudeHookEvent;
}

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
