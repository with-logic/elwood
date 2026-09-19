/** Codex tool-hook maps select only OWN handlers, as Claude's do (PRD §7A.2, C-HOOK-19). */

import { expect, test, vi } from "vitest";
import { requestCodexHook } from "../../src/codex/hooks/dispatch.ts";
import type { CodexHookEvent } from "../../src/codex/hooks/index.ts";
import { registerInitialHooks } from "../../src/codex/session/hooks.ts";
import type { CodexEventMap } from "../../src/codex/session/types.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";

const rewrite = { permissionDecision: "allow", updatedInput: { command: "after" } } as const;

function dispatch(
  tool_name: string,
  handlers: Readonly<Record<string, unknown>>,
  errors?: string[],
) {
  const emitter = new TypedEmitter<CodexEventMap>();
  if (errors) emitter.on("hookError", (event) => errors.push(event.category));
  registerInitialHooks(emitter, { PreToolUse: handlers } as never);
  const event = {
    hook_event_name: "PreToolUse",
    session_id: "codex-1",
    cwd: "/tmp",
    turn_id: "turn-1",
    tool_name,
    tool_input: { command: "before" },
  } as CodexHookEvent;
  return requestCodexHook(emitter, event, 1000, "session");
}

test.each([
  "toString",
  "constructor",
  "mcp__server__tool",
])("C-HOOK-19 ignores an inherited %s handler", async (name) => {
  const inherited = vi.fn(() => rewrite);
  const handlers = Object.create({ [name]: inherited }) as Record<string, unknown>;
  expect(await dispatch(name, handlers)).toEqual({ result: undefined, failedOpen: false });
  expect(inherited).not.toHaveBeenCalled();
});

test.each([
  "mcp__server__tool",
  "unknown:future",
])("C-HOOK-19 ignores an inherited unknown fallback for %s", async (name) => {
  const inherited = vi.fn(() => rewrite);
  const handlers = Object.create({ unknown: inherited }) as Record<string, unknown>;
  expect(await dispatch(name, handlers)).toEqual({ result: undefined, failedOpen: false });
  expect(inherited).not.toHaveBeenCalled();
});

/**
 * `Object.prototype` is on EVERY handler-map literal, so a bare property lookup turns
 * its members into a routing table the caller never wrote: a crafted tool name SELECTED
 * an inherited method and dispatch then tried to invoke it. These are detached calls, so
 * they throw before result validation and the dispatcher reports `handler_error` —
 * `failedOpen: true` for a tool the caller never registered anything for. Own-property
 * lookup makes the map simply not match, which is the correct no-decision outcome.
 */
test.each([
  "valueOf",
  "toLocaleString",
])("C-HOOK-19 the Object.prototype member %s is not a handler", async (name) => {
  // No `unknown` fallback is registered, so this map answers for NO tool but `Bash`.
  const errors: string[] = [];
  const outcome = await dispatch(name, { Bash: () => rewrite }, errors);
  expect(outcome).toEqual({ result: undefined, failedOpen: false });
  expect(errors).toEqual([]);
});

test("C-HOOK-19 preserves own exact and unknown routing", async () => {
  const Bash = vi.fn(() => rewrite);
  const unknown = vi.fn(() => rewrite);
  expect(await dispatch("Bash", { Bash, unknown })).toEqual({ result: rewrite, failedOpen: false });
  expect(Bash).toHaveBeenCalledOnce();
  expect(unknown).not.toHaveBeenCalled();
  expect(await dispatch("mcp__server__tool", { unknown })).toEqual({
    result: rewrite,
    failedOpen: false,
  });
  expect(unknown).toHaveBeenCalledOnce();
});
