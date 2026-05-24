/**
 * Focused unit coverage for browser dev app helpers.
 * Covers PRD §9 and §10.
 */

import { describe, expect, test } from "bun:test";
import { clientScript, renderHtml } from "../../src/app/web-assets.ts";
import { summarizeHookEvent } from "../../src/app/web-log.ts";
import { parseClientMessage, sizeFrom } from "../../src/app/web-messages.ts";
import type { ClaudeHookEvent } from "../../src/index.ts";

describe("browser dev app helpers", () => {
  test("C-APP-08 renders the shell and client script", () => {
    expect(renderHtml("/tmp/project")).toContain('value="/tmp/project"');
    expect(renderHtml("/tmp/project")).toContain('value="codex"');
    expect(renderHtml("/tmp/project")).toContain("/client.js");
    expect(clientScript()).toContain("new Terminal");
    expect(clientScript()).toContain("agent:");
    expect(clientScript()).toContain('send({ type: "resize"');
  });

  test("C-APP-08 parses client messages and terminal sizes", () => {
    expect(parseClientMessage('{"type":"kill"}')).toEqual({ type: "kill" });
    expect(parseClientMessage('{"type":"start","agent":"codex","cwd":"."}')).toMatchObject({
      agent: "codex",
    });
    expect(sizeFrom({ cols: 120, rows: 40 })).toEqual({ cols: 120, rows: 40 });
    expect(() => parseClientMessage("null")).toThrow("Invalid client message.");
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
});

function hook(fields: Partial<ClaudeHookEvent>): ClaudeHookEvent {
  return {
    hook_event_name: "Notification",
    session_id: "claude-1",
    cwd: "/tmp/project",
    ...fields,
  } as ClaudeHookEvent;
}
