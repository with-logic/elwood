/**
 * Compile-time checks for tool-specific hook response rewrites.
 * Covers PRD §6.4 and §7A.2.
 */

import { describe, expect, test } from "vitest";
import type {
  AskUserQuestionInput,
  ClaudeHookEventFor,
  ClaudeHookHandlers,
  ClaudeHookResultForEvent,
  CodexCommandToolInput,
  CodexHookEventFor,
  CodexHookHandlers,
  CodexHookResultForEvent,
} from "../../src/index.ts";

describe("tool-specific hook response types", () => {
  test("C-HRESP-01 Claude known tool rewrites use the active tool input type", () => {
    type ClaudeBashEvent = Extract<
      ClaudeHookEventFor<"PreToolUse">,
      { readonly tool_name: "Bash" }
    >;
    const valid: ClaudeHookResultForEvent<ClaudeBashEvent> = {
      permissionDecision: "allow",
      updatedInput: { command: "echo ok" },
    };
    const invalid: ClaudeHookResultForEvent<ClaudeBashEvent> = {
      permissionDecision: "allow",
      // @ts-expect-error Bash command rewrites must remain strings.
      updatedInput: { command: 42 },
    };
    expect(typeof valid).toBe("object");
    expect(typeof invalid).toBe("object");
  });

  test("C-HRESP-01 Claude handler maps require tool-keyed input rewrites", () => {
    const valid = {
      PreToolUse: {
        AskUserQuestion: () => {
          const updatedInput = {
            answers: { first: "answer" },
          } satisfies Partial<AskUserQuestionInput>;
          return { permissionDecision: "allow", updatedInput };
        },
      },
    } satisfies ClaudeHookHandlers;
    const invalid = {
      // @ts-expect-error function-form PreToolUse handlers cannot rewrite tool input.
      PreToolUse: () => ({
        permissionDecision: "allow",
        updatedInput: { answers: { first: "answer" } },
      }),
    } satisfies ClaudeHookHandlers;
    expect(typeof valid.PreToolUse).toBe("object");
    expect(typeof invalid.PreToolUse).toBe("function");
  });

  test("C-HRESP-01 Codex known tool rewrites use the active tool input type", () => {
    type CodexBashEvent = CodexHookEventFor<"PreToolUse"> & {
      readonly tool_name: "Bash";
      readonly tool_input: CodexCommandToolInput;
    };
    const valid: CodexHookResultForEvent<CodexBashEvent> = {
      permissionDecision: "allow",
      updatedInput: { command: "echo ok" },
    };
    const invalid: CodexHookResultForEvent<CodexBashEvent> = {
      permissionDecision: "allow",
      // @ts-expect-error Codex Bash command rewrites must remain strings.
      updatedInput: { command: 42 },
    };
    expect(typeof valid).toBe("object");
    expect(typeof invalid).toBe("object");
  });

  test("C-HRESP-01 Codex handler maps require tool-keyed input rewrites", () => {
    const valid = {
      PreToolUse: {
        apply_patch: (event) => {
          const command: string = event.tool_input.command;
          return { permissionDecision: "allow", updatedInput: { command } };
        },
      },
    } satisfies CodexHookHandlers;
    const invalid = {
      // @ts-expect-error function-form PreToolUse handlers cannot rewrite tool input.
      PreToolUse: () => ({
        permissionDecision: "allow",
        updatedInput: { command: "echo" },
      }),
    } satisfies CodexHookHandlers;
    expect(typeof valid.PreToolUse).toBe("object");
    expect(typeof invalid.PreToolUse).toBe("function");
  });
});
