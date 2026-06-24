/**
 * Focused coverage for Codex hook handler registration forms.
 * Covers PRD §7A.2.
 */

import { describe, expect, test } from "vitest";
import { registerInitialHooks } from "../../src/codex/session-hooks.ts";
import type { CodexEventMap } from "../../src/codex/session-types.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";

describe("Codex hook registration", () => {
  test("C-HRESP-01 routes object-form PreToolUse handlers by tool name", async () => {
    const emitter = new TypedEmitter<CodexEventMap>();
    registerInitialHooks(emitter, {
      PreToolUse: {
        Bash: () => ({ permissionDecision: "allow" }),
        unknown: () => ({ additionalContext: "unknown tool" }),
      },
    });
    await expect(emitter.request("hook:PreToolUse", bashEvent())).resolves.toMatchObject({
      permissionDecision: "allow",
    });
    await expect(emitter.request("hook:PreToolUse", unknownEvent())).resolves.toMatchObject({
      additionalContext: "unknown tool",
    });
  });

  test("C-HRESP-01 invalid object-form non-tool handlers fail open", async () => {
    const emitter = new TypedEmitter<CodexEventMap>();
    registerInitialHooks(emitter, { Stop: {} as never });
    await expect(emitter.request("hook:Stop", stopEvent())).resolves.toBeUndefined();
  });
});

function bashEvent() {
  return {
    hook_event_name: "PreToolUse",
    session_id: "codex-1",
    cwd: "/tmp/project",
    turn_id: "turn-1",
    tool_name: "Bash",
    tool_input: { command: "echo ok" },
  } as const;
}

function unknownEvent() {
  return {
    hook_event_name: "PreToolUse",
    session_id: "codex-1",
    cwd: "/tmp/project",
    turn_id: "turn-1",
    tool_name: "unknown:web_search",
    tool_input: { query: "docs" },
  } as const;
}

function stopEvent() {
  return {
    hook_event_name: "Stop",
    session_id: "codex-1",
    cwd: "/tmp/project",
    turn_id: "turn-1",
    stop_hook_active: false,
  } as const;
}
