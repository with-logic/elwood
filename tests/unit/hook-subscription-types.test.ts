/** Compile-time regression tests for tool-keyed rewrites (PRD §6.4, §7A.2). */

import { expect, test } from "vitest";
import type { ClaudeEventHandler, ClaudeHookHandlers, CodexEventHandler } from "../../src/index.ts";

test("C-HRESP-01 narrows PermissionRequest map responses by tool", () => {
  const handlers: ClaudeHookHandlers = {
    PermissionRequest: {
      // @ts-expect-error Bash rewrites must contain a string command.
      Bash: () => ({ behavior: "allow", updatedInput: { command: 42 } }),
      // @ts-expect-error TaskGet rewrites must contain a string id.
      TaskGet: () => ({ behavior: "allow", updatedInput: { id: 42 } }),
    },
  };
  expect(handlers.PermissionRequest).toBeDefined();
});

test("C-HRESP-01 event-name subscriptions cannot rewrite tool inputs", () => {
  const rewrite = { permissionDecision: "allow", updatedInput: { command: "after" } } as const;
  const permissionRewrite = { behavior: "allow", updatedInput: { id: "after" } } as const;
  // @ts-expect-error Only tool-keyed Claude handlers can return updatedInput.
  const claude: ClaudeEventHandler<"hook:PreToolUse"> = () => rewrite;
  // @ts-expect-error PermissionRequest follows the same tool-keyed rule.
  const permission: ClaudeEventHandler<"hook:PermissionRequest"> = () => permissionRewrite;
  // @ts-expect-error Only tool-keyed Codex handlers can return updatedInput.
  const codex: CodexEventHandler<"hook:PreToolUse"> = () => rewrite;
  expect([claude, permission, codex]).toHaveLength(3);
});

test("C-HRESP-01 context and deny branches cannot disguise input rewrites", () => {
  const rewrite = { additionalContext: "context", updatedInput: { command: "after" } } as const;
  const deny = {
    permissionDecision: "deny",
    permissionDecisionReason: "reason",
    updatedInput: { command: "after" },
  } as const;
  // @ts-expect-error Context-only subscriptions cannot carry updatedInput.
  const claude: ClaudeEventHandler<"hook:PreToolUse"> = () => rewrite;
  // @ts-expect-error Context-only Codex subscriptions cannot carry updatedInput.
  const codex: CodexEventHandler<"hook:PreToolUse"> = () => rewrite;
  // @ts-expect-error A denial does not permit updatedInput.
  const denied: CodexEventHandler<"hook:PreToolUse"> = () => deny;
  const keyed: ClaudeHookHandlers = {
    PreToolUse: {
      // @ts-expect-error Additional context must not weaken the selected Bash input type.
      Bash: () => ({
        additionalContext: "context",
        permissionDecision: "allow",
        updatedInput: { command: 42 },
      }),
    },
  };
  expect([claude, codex, denied, keyed]).toHaveLength(4);
});
