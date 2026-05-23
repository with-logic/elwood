/**
 * Compile-time conformance checks for the public Claude hook API.
 * Covers PRD §6.4 and §7.
 */

import { describe, expect, test } from "bun:test";
import type { AskUserQuestionInput, ClaudeHookEvent, ClaudeHookHandlers } from "../../src/index.ts";

describe("public hook types", () => {
  test("C-HOOK-08 C-HRESP-04 hook names narrow valid response types", () => {
    const handlers = {
      Stop: () => ({ decision: "block", reason: "tests are failing" }),
      Notification: () => undefined,
    } satisfies ClaudeHookHandlers;

    const invalid = {
      // @ts-expect-error Notification is observe-only and cannot block Claude.
      Notification: () => ({ decision: "block", reason: "not allowed" }),
    } satisfies ClaudeHookHandlers;

    expect(typeof handlers.Stop).toBe("function");
    expect(typeof invalid.Notification).toBe("function");
  });

  test("C-HOOK-09 C-HOOK-10 known and unknown tool inputs use typed paths", () => {
    const handlers = {
      PreToolUse: (event) => {
        if (event.tool_name === "Bash") {
          const command: string = event.tool_input.command;
          return { permissionDecision: "deny", permissionDecisionReason: command };
        }
        if (event.tool_name === "AskUserQuestion") {
          const updatedInput = {
            answers: { first: "answer" },
          } satisfies Partial<AskUserQuestionInput>;
          return { permissionDecision: "allow", updatedInput };
        }
        return undefined;
      },
    } satisfies ClaudeHookHandlers;

    const unknownTool = {
      hook_event_name: "PreToolUse",
      session_id: "claude-1",
      cwd: "/tmp/project",
      tool_name: "mcp__server__tool",
      tool_input: { raw: true },
    } satisfies ClaudeHookEvent;

    expect(typeof handlers.PreToolUse).toBe("function");
    expect(unknownTool.tool_input.raw).toBe(true);
  });
});
