/**
 * Non-finite numbers are rejected by hook numeric validation before they can
 * reach the bridge response. Covers PRD §6.4 and C-HOOK-18.
 */

import { describe, expect, test } from "vitest";
import { requestHook } from "../../src/claude/hooks/dispatch.ts";
import { serializeHookResult } from "../../src/claude/serialize.ts";
import { registerInitialHooks } from "../../src/claude/session/runtime.ts";
import { isClaudeHookInput } from "../../src/claude/validate/input.ts";
import { isClaudeHookResult } from "../../src/claude/validate/result.ts";
import { isFiniteNumber, optionalFiniteNumber } from "../../src/core/predicates.ts";
import type { ClaudeEventMap, HookErrorEvent } from "../../src/core/types.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";
import { tool } from "./claude-validate-input-helpers.ts";

const nonFinite = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

/** `JSON.stringify` turns exactly these values into `null`; that is why they must not pass. */
describe("non-finite hook numbers", () => {
  test("C-HOOK-18 the shared predicates reject non-finite numbers", () => {
    for (const value of nonFinite) {
      expect(isFiniteNumber(value)).toBe(false);
      expect(optionalFiniteNumber(value)).toBe(false);
      expect(JSON.stringify({ value })).toBe('{"value":null}');
    }
    expect(isFiniteNumber(0)).toBe(true);
    expect(optionalFiniteNumber(undefined)).toBe(true);
    expect(optionalFiniteNumber(1.5)).toBe(true);
  });

  test.each(nonFinite)("C-HOOK-18 ingress rejects a non-finite tool input (%s)", (value) => {
    expect(isClaudeHookInput(tool("Read", { file_path: "/tmp/a", offset: value }))).toBe(false);
    expect(isClaudeHookInput(tool("Read", { file_path: "/tmp/a", offset: 1 }))).toBe(true);
    // The inline TaskOutput.timeout check is a REQUIRED number, not `optionalFiniteNumber`.
    expect(
      isClaudeHookInput(tool("TaskOutput", { task_id: "t", block: true, timeout: value })),
    ).toBe(false);
  });

  test.each(nonFinite)("C-HOOK-18 a non-finite rewrite is not a valid result (%s)", (value) => {
    const event = tool("Read", { file_path: "/tmp/a" });
    expect(
      isClaudeHookResult(event as never, {
        permissionDecision: "allow",
        updatedInput: { file_path: "/tmp/a", limit: value },
      }),
    ).toBe(false);
    expect(
      isClaudeHookResult(event as never, {
        permissionDecision: "allow",
        updatedInput: { file_path: "/tmp/a", limit: 10 },
      }),
    ).toBe(true);
  });

  /**
   * The rule is structural, not per-schema: MCP/generic/future tools have NO field table,
   * so without a recursive check a schema-less rewrite still serialized `"x": null`.
   */
  test.each(nonFinite)("C-HOOK-18 a SCHEMA-LESS tool rejects a non-finite too (%s)", (value) => {
    const mcp = tool("mcp__server__tool", { anything: 1 });
    for (const updatedInput of [
      { budget: value },
      { nested: { deep: value } },
      { list: [1, value] },
      { deep: [{ inner: value }] },
    ]) {
      expect(isClaudeHookResult(mcp as never, { permissionDecision: "allow", updatedInput })).toBe(
        false,
      );
    }
    // A schema-less tool still accepts any FINITE shape, including nested records.
    expect(
      isClaudeHookResult(mcp as never, {
        permissionDecision: "allow",
        updatedInput: { budget: 1, nested: { deep: 2 }, list: [3], text: "x", flag: null },
      }),
    ).toBe(true);
    // Ingress for a schema-less tool is guarded by the same rule.
    expect(isClaudeHookInput(tool("mcp__server__tool", { x: value }))).toBe(false);
    expect(isClaudeHookInput(tool("mcp__server__tool", { x: 1 }))).toBe(true);
  });

  test.each(nonFinite)("C-HOOK-18 other numeric validation paths reject %s", (value) => {
    // `PermissionRequest.updatedInput` is a SEPARATE result branch from `PreToolUse`.
    expect(
      isClaudeHookResult(tool("Read", { file_path: "/a" }, "PermissionRequest") as never, {
        behavior: "allow",
        updatedInput: { limit: value },
      }),
    ).toBe(false);
    // Event-level numeric fields are validated by their own table, not a tool schema.
    // Each of these events also has its own required field, so both are supplied.
    for (const [event, extra] of [
      ["PostToolUse", { tool_response: "ok" }],
      ["PostToolUseFailure", { error: "failed" }],
    ] as const) {
      const at = (duration_ms: number) =>
        isClaudeHookInput(tool("Bash", { command: "x" }, event, { ...extra, duration_ms }));
      expect(at(value)).toBe(false);
      expect(at(12)).toBe(true);
    }
  });

  test.each(
    nonFinite,
  )("C-HOOK-18 a non-finite rewrite never reaches the bridge response (%s)", async (value) => {
    const errors: HookErrorEvent[] = [];
    const { outcome } = await rewriteThroughBridge(value, errors);
    expect(outcome.failedOpen).toBe(true);
    expect(outcome.result).toBeUndefined();
    expect(errors[0]?.category).toBe("invalid_response");
    // The bridge answers with NO decision rather than a `"limit": null` rewrite.
    expect(serializeHookResult("PreToolUse", outcome.result)).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  });

  test("C-HOOK-18 a finite rewrite still serializes onto the bridge response", async () => {
    const { outcome, response } = await rewriteThroughBridge(10, []);
    expect(outcome.failedOpen).toBe(false);
    expect(JSON.parse(response.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { file_path: "/tmp/a", limit: 10 },
      },
    });
  });
});

/** Runs a tool-keyed `Read` rewrite through real dispatch and the real serializer. */
async function rewriteThroughBridge(limit: number, errors: HookErrorEvent[]) {
  const emitter = new TypedEmitter<ClaudeEventMap>();
  emitter.on("hookError", (error) => errors.push(error));
  registerInitialHooks(emitter, {
    PreToolUse: {
      Read: () => ({
        permissionDecision: "allow" as const,
        updatedInput: { file_path: "/tmp/a", limit },
      }),
    },
  } as never);
  const event = tool("Read", { file_path: "/tmp/a" });
  const outcome = await requestHook(emitter, event as never, 1_000, "sess-1");
  return { outcome, response: serializeHookResult("PreToolUse", outcome.result) };
}
