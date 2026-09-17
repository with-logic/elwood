/** Claude tool-hook maps select only own handlers within their typed domain (PRD §6.4). */

import { expect, test, vi } from "vitest";
import { requestHook } from "../../src/claude/hooks/dispatch.ts";
import type { ClaudeHookEvent } from "../../src/claude/hooks/index.ts";
import { registerInitialHooks } from "../../src/claude/session/runtime.ts";
import type { ClaudeEventMap } from "../../src/core/types.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";

for (const hook_event_name of ["PreToolUse", "PermissionRequest"] as const) {
  const rewrite =
    hook_event_name === "PreToolUse"
      ? ({ permissionDecision: "allow", updatedInput: { command: "after" } } as const)
      : ({ behavior: "allow", updatedInput: { command: "after" } } as const);

  const dispatch = (tool_name: string, handlers: Readonly<Record<string, unknown>>) => {
    const emitter = new TypedEmitter<ClaudeEventMap>();
    registerInitialHooks(emitter, { [hook_event_name]: handlers } as never);
    const event = {
      hook_event_name,
      session_id: "claude-1",
      cwd: "/tmp",
      tool_name,
      tool_input: { command: "before" },
    } as ClaudeHookEvent;
    return requestHook(emitter, event, 1000, "session");
  };

  test.each([
    "Bash",
    "LS",
  ])(`C-HRESP-01 ${hook_event_name} never routes known %s to unknown`, async (name) => {
    const unknown = vi.fn(() => rewrite);
    expect(await dispatch(name, { unknown })).toEqual({ result: undefined, failedOpen: false });
    expect(unknown).not.toHaveBeenCalled();
  });

  test(`C-HRESP-01 ${hook_event_name} preserves own known-tool rewrites and provenance`, async () => {
    const Bash = vi.fn(() => rewrite);
    const unknown = vi.fn(() => rewrite);
    expect(await dispatch("Bash", { Bash, unknown })).toEqual({
      result: rewrite,
      failedOpen: false,
    });
    expect(Bash).toHaveBeenCalledOnce();
    expect(unknown).not.toHaveBeenCalled();
  });

  test.each([
    "mcp__server__tool",
    "unknown:future",
  ])(`C-HRESP-01 ${hook_event_name} routes %s to an own unknown fallback`, async (name) => {
    const unknown = vi.fn(() => rewrite);
    expect(await dispatch(name, { unknown })).toEqual({ result: rewrite, failedOpen: false });
    expect(unknown).toHaveBeenCalledOnce();
  });

  test.each([
    "Bash",
    "mcp__server__tool",
  ])(`C-HRESP-01 ${hook_event_name} ignores an inherited %s handler`, async (name) => {
    const inherited = vi.fn(() => rewrite);
    const handlers = Object.create({ [name]: inherited }) as Record<string, unknown>;
    expect(await dispatch(name, handlers)).toEqual({ result: undefined, failedOpen: false });
    expect(inherited).not.toHaveBeenCalled();
  });

  test.each([
    "mcp__server__tool",
    "unknown:future",
  ])(`C-HRESP-01 ${hook_event_name} ignores inherited unknown fallback for %s`, async (name) => {
    const inherited = vi.fn(() => rewrite);
    const handlers = Object.create({ unknown: inherited }) as Record<string, unknown>;
    expect(await dispatch(name, handlers)).toEqual({ result: undefined, failedOpen: false });
    expect(inherited).not.toHaveBeenCalled();
  });

  test(`C-HRESP-01 ${hook_event_name} prioritizes an own exact MCP handler`, async () => {
    const exact = vi.fn(() => rewrite);
    const unknown = vi.fn(() => rewrite);
    expect(await dispatch("mcp__server__tool", { mcp__server__tool: exact, unknown })).toEqual({
      result: rewrite,
      failedOpen: false,
    });
    expect(exact).toHaveBeenCalledOnce();
    expect(unknown).not.toHaveBeenCalled();
  });
}
