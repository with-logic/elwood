/**
 * Compile-time conformance checks for the public Claude hook API.
 * Covers PRD §6.4 and §7.
 */

import { describe, expect, test } from "vitest";
import type {
  ClaudeBackgroundTask,
  ClaudeHookEvent,
  ClaudeHookEventFor,
  ClaudeHookHandlers,
  ClaudeSessionCron,
  CodexHookEvent,
  CodexHookHandlers,
  PreToolUseResult,
} from "../../src/index.ts";

describe("public hook types", () => {
  test("C-HOOK-08 C-HRESP-04 hook names narrow valid response types", () => {
    const handlers = {
      Stop: () => ({ decision: "block", reason: "tests are failing" }),
      Notification: () => undefined,
    } satisfies ClaudeHookHandlers;

    const invalid = {
      // @ts-expect-error Notification is observe-only and cannot block Claude.
      Notification: () => ({ decision: "block", reason: "not allowed" }),
      // @ts-expect-error Stop must block with a reason or return no decision.
      Stop: () => ({ additionalContext: "not enough" }),
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

    const invalidUpdatedInput = {
      permissionDecision: "allow",
      // @ts-expect-error updatedInput must be a tool-input object, not a scalar.
      updatedInput: 42,
    } satisfies PreToolUseResult;
    expect(typeof handlers.PreToolUse).toBe("function");
    expect(typeof invalidUpdatedInput).toBe("object");
    expect(unknownTool.tool_input.raw).toBe(true);
  });

  test("C-HOOK-14 Codex known tool inputs narrow by tool name", () => {
    const handlers = {
      PreToolUse: (event) => {
        if (event.tool_name === "Bash") {
          const command: string = event.tool_input.command;
          return { permissionDecision: "deny", permissionDecisionReason: command };
        }
        // @ts-expect-error Unknown Codex tools do not guarantee command input.
        const command: string = event.tool_input.command;
        return command ? { additionalContext: command } : undefined;
      },
    } satisfies CodexHookHandlers;

    const invalid = {
      // @ts-expect-error PostToolUse is observe-only in the Codex API.
      PostToolUse: () => ({ decision: "block", reason: "unsupported" }),
      PreToolUse: () => undefined,
    } satisfies CodexHookHandlers;

    const rawFutureTool = {
      hook_event_name: "PreToolUse",
      session_id: "codex-1",
      cwd: "/tmp/project",
      turn_id: "turn-1",
      // @ts-expect-error Raw future tool names are normalized to unknown:<name>.
      tool_name: "web_search",
      tool_input: {},
    } satisfies CodexHookEvent;
    expect(typeof handlers.PreToolUse).toBe("function");
    expect(typeof invalid.PostToolUse).toBe("function");
    expect(rawFutureTool.tool_name).toBe("web_search");
  });

  test("C-HOOK-08 documented lifecycle payload fields are typed for consumers", () => {
    const handlers = {
      Stop: (event) => {
        const message: string | undefined = event.last_assistant_message;
        const tasks: readonly ClaudeBackgroundTask[] | undefined = event.background_tasks;
        const crons: readonly ClaudeSessionCron[] | undefined = event.session_crons;
        const firstCommand: string | undefined = tasks?.[0]?.command;
        return (message ?? firstCommand ?? crons?.[0]?.prompt === undefined)
          ? undefined
          : { decision: "block", reason: "not done" };
      },
      SubagentStop: (event) => {
        const message: string | undefined = event.last_assistant_message;
        const transcript: string = event.agent_transcript_path;
        return message === transcript ? { decision: "block", reason: "unexpected" } : undefined;
      },
      StopFailure: (event) => {
        const message: string | undefined = event.last_assistant_message;
        const error: string = event.error;
        return message === error ? undefined : undefined;
      },
      Notification: (event) => {
        const message: string = event.message;
        const notificationType: string = event.notification_type;
        return message === notificationType ? undefined : undefined;
      },
      PostCompact: (event) => {
        const summary: string = event.compact_summary;
        return summary ? undefined : undefined;
      },
    } satisfies ClaudeHookHandlers;

    const stopEvent = {
      hook_event_name: "Stop",
      session_id: "claude-1",
      cwd: "/tmp/project",
      last_assistant_message: "Done",
      background_tasks: [
        { id: "task-1", type: "shell", status: "running", command: "tail -f log" },
      ],
      session_crons: [{ id: "cron-1", schedule: "0 * * * *", recurring: true, prompt: "check" }],
    } satisfies ClaudeHookEventFor<"Stop">;

    expect(typeof handlers.Stop).toBe("function");
    expect(stopEvent.last_assistant_message).toBe("Done");
  });

  test("C-HOOK-08 documented non-tool payload fields are typed for consumers", () => {
    const events = [
      {
        hook_event_name: "InstructionsLoaded",
        session_id: "claude-1",
        cwd: "/tmp/project",
        file_path: "/tmp/project/CLAUDE.md",
        memory_type: "Project",
        load_reason: "session_start",
      } satisfies ClaudeHookEventFor<"InstructionsLoaded">,
      {
        hook_event_name: "TaskCreated",
        session_id: "claude-1",
        cwd: "/tmp/project",
        task_id: "task-1",
        task_subject: "Implement feature",
      } satisfies ClaudeHookEventFor<"TaskCreated">,
      {
        hook_event_name: "FileChanged",
        session_id: "claude-1",
        cwd: "/tmp/project",
        file_path: "/tmp/project/.env",
        event: "change",
      } satisfies ClaudeHookEventFor<"FileChanged">,
      {
        hook_event_name: "Elicitation",
        session_id: "claude-1",
        cwd: "/tmp/project",
        mcp_server_name: "server",
        message: "Authenticate",
        mode: "url",
        url: "https://example.com",
      } satisfies ClaudeHookEventFor<"Elicitation">,
    ] satisfies readonly ClaudeHookEvent[];

    expect(events.map((event) => event.hook_event_name)).toEqual([
      "InstructionsLoaded",
      "TaskCreated",
      "FileChanged",
      "Elicitation",
    ]);
  });
});
