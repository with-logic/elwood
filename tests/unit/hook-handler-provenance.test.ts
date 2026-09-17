/** Runtime enforcement of tool-keyed hook rewrites (PRD §6.4, §7A.2 / C-HRESP-01). */

import { expect, test } from "vitest";
import { requestHook } from "../../src/claude/hooks/dispatch.ts";
import { registerInitialHooks as registerClaude } from "../../src/claude/session/runtime.ts";
import { requestCodexHook } from "../../src/codex/hooks/dispatch.ts";
import { registerInitialHooks as registerCodex } from "../../src/codex/session/hooks.ts";
import type { CodexEventMap } from "../../src/codex/session/types.ts";
import type { ClaudeEventMap } from "../../src/core/types.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";

const tool = {
  session_id: "agent-1",
  cwd: "/tmp",
  turn_id: "turn",
  tool_name: "Bash",
  tool_input: { command: "before" },
} as const;
const preRewrite = { permissionDecision: "allow", updatedInput: { command: "after" } } as const;
const permissionRewrite = { behavior: "allow", updatedInput: { command: "after" } } as const;

for (const hook_event_name of ["PreToolUse", "PermissionRequest"] as const) {
  test.each([
    "constructor",
    "subscription",
  ])(`C-HRESP-01 rejects event-level Claude ${hook_event_name} rewrites through %s`, async (registration) => {
    const emitter = new TypedEmitter<ClaudeEventMap>();
    const errors: string[] = [];
    emitter.on("hookError", (event) => errors.push(event.category));
    const rewrite = hook_event_name === "PreToolUse" ? preRewrite : permissionRewrite;
    if (registration === "constructor")
      registerClaude(emitter, { [hook_event_name]: () => rewrite } as never);
    else emitter.on(`hook:${hook_event_name}`, () => rewrite);
    const outcome = await requestHook(emitter, { ...tool, hook_event_name }, 1000, "session");
    expect(outcome).toEqual({ result: undefined, failedOpen: true });
    expect(errors).toEqual(["invalid_response"]);
  });

  test(`C-HRESP-01 preserves keyed Claude ${hook_event_name} rewrites`, async () => {
    const emitter = new TypedEmitter<ClaudeEventMap>();
    const rewrite = hook_event_name === "PreToolUse" ? preRewrite : permissionRewrite;
    registerClaude(emitter, { [hook_event_name]: { Bash: () => rewrite } } as never);
    expect(await requestHook(emitter, { ...tool, hook_event_name }, 1000, "session")).toEqual({
      result: rewrite,
      failedOpen: false,
    });
  });
}

test.each([
  "constructor",
  "subscription",
])("C-HRESP-01 rejects event-level Codex rewrites through %s", async (registration) => {
  const emitter = new TypedEmitter<CodexEventMap>();
  const errors: string[] = [];
  emitter.on("hookError", (event) => errors.push(event.category));
  if (registration === "constructor")
    registerCodex(emitter, { PreToolUse: () => preRewrite } as never);
  else emitter.on("hook:PreToolUse", () => preRewrite);
  const outcome = await requestCodexHook(
    emitter,
    { ...tool, hook_event_name: "PreToolUse" },
    1000,
    "session",
  );
  expect(outcome).toEqual({ result: undefined, failedOpen: true });
  expect(errors).toEqual(["invalid_response"]);
});

test("C-HRESP-01 preserves keyed Codex rewrites", async () => {
  const emitter = new TypedEmitter<CodexEventMap>();
  registerCodex(emitter, { PreToolUse: { Bash: () => preRewrite } });
  expect(
    await requestCodexHook(emitter, { ...tool, hook_event_name: "PreToolUse" }, 1000, "session"),
  ).toEqual({ result: preRewrite, failedOpen: false });
});

test("C-HRESP-01 uses provenance of the responding handler after a keyed handler abstains", async () => {
  const emitter = new TypedEmitter<ClaudeEventMap>();
  registerClaude(emitter, { PreToolUse: { Bash: () => undefined } });
  emitter.on("hook:PreToolUse", () => preRewrite);
  expect(
    await requestHook(emitter, { ...tool, hook_event_name: "PreToolUse" }, 1000, "session"),
  ).toEqual({ result: undefined, failedOpen: true });
});

test("C-HRESP-01 an abstaining event observer does not strip a later keyed response", async () => {
  const emitter = new TypedEmitter<ClaudeEventMap>();
  emitter.on("hook:PreToolUse", () => undefined);
  registerClaude(emitter, { PreToolUse: { Bash: async () => preRewrite } });
  expect(
    await requestHook(emitter, { ...tool, hook_event_name: "PreToolUse" }, 1000, "session"),
  ).toEqual({ result: preRewrite, failedOpen: false });
});

test("C-HRESP-01 all abstaining handlers produce no decision without an error", async () => {
  const emitter = new TypedEmitter<ClaudeEventMap>();
  registerClaude(emitter, { PreToolUse: { Bash: () => undefined } });
  expect(
    await requestHook(emitter, { ...tool, hook_event_name: "PreToolUse" }, 1000, "session"),
  ).toEqual({ result: undefined, failedOpen: false });
});
