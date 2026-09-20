/** Structural finite-number validation bounds and bridge behavior (PRD §6.4, C-HOOK-18). */
import { describe, expect, test } from "vitest";
import { requestHook } from "../../src/claude/hooks/dispatch.ts";
import { serializeHookResult } from "../../src/claude/serialize.ts";
import { registerInitialHooks } from "../../src/claude/session/runtime.ts";
import { isClaudeHookInput } from "../../src/claude/validate/input.ts";
import { isClaudeHookResult } from "../../src/claude/validate/result.ts";
import { isBoundedJsonShape } from "../../src/core/predicates.ts";
import type { ClaudeEventMap, HookErrorEvent } from "../../src/core/types.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";
import { tool } from "./claude-validate-input-helpers.ts";

function nested(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = {};
  for (let i = 0; i < depth; i += 1) value = { child: value };
  return value;
}

function cyclic(): Record<string, unknown> {
  const value: Record<string, unknown> = { finite: 1 };
  value["self"] = value;
  return value;
}

const rejectedShapes = [
  ["cycle", cyclic],
  [
    "array cycle",
    () => {
      const array: unknown[] = [];
      array.push(array);
      return { array };
    },
  ],
  ["deep", () => nested(129)],
  ["wide array", () => ({ children: Array.from({ length: 100_000 }, () => 1) })],
  ["wide record", () => Object.fromEntries(Array.from({ length: 100_000 }, (_, i) => [i, 1]))],
] as const;

describe("structural finite-number validation", () => {
  test.each(rejectedShapes)("C-HOOK-18 rejects %s without throwing", (_name, make) => {
    const updatedInput = make();
    expect(isBoundedJsonShape(updatedInput)).toBe(false);
    expect(isClaudeHookInput(tool("mcp__server__tool", updatedInput))).toBe(false);
    const event = tool("mcp__server__tool", {});
    expect(isClaudeHookResult(event as never, { permissionDecision: "allow", updatedInput })).toBe(
      false,
    );
  });

  test.each(
    rejectedShapes,
  )("C-HOOK-18 a %s rewrite reports invalid_response", async (_name, make) => {
    const { outcome, errors, response } = await rewrite(make());
    expect(outcome.failedOpen).toBe(true);
    expect(outcome.result).toBeUndefined();
    expect(errors.map((error) => error.category)).toEqual(["invalid_response"]);
    expect(response).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  test("C-HOOK-18 allows exactly 128 edges from the input root", async () => {
    const atLimit = nested(128);
    expect(isBoundedJsonShape(atLimit)).toBe(true);
    expect(isBoundedJsonShape(nested(129))).toBe(false);
    expect(isBoundedJsonShape({ child: nested(128) })).toBe(false);
    // The response envelope has its own root-relative limit (C-HOOK-21).
    const rewriteAtLimit = nested(127);
    const { outcome, response } = await rewrite(rewriteAtLimit);
    expect(outcome.failedOpen).toBe(false);
    expect(JSON.parse(response.stdout).hookSpecificOutput.updatedInput).toEqual(rewriteAtLimit);
  });

  test("C-HOOK-18 counts the root and primitive visits toward the 100,000 limit", () => {
    expect(isBoundedJsonShape(Array.from({ length: 99_999 }, () => 1))).toBe(true);
    expect(isBoundedJsonShape(Array.from({ length: 100_000 }, () => 1))).toBe(false);
    expect(isBoundedJsonShape(1)).toBe(true);
    expect(isBoundedJsonShape(null)).toBe(true);
    expect(isBoundedJsonShape(undefined)).toBe(true);
    expect(isBoundedJsonShape({ text: "ok", enabled: true, absent: undefined })).toBe(true);
  });

  test("C-HOOK-18 rechecks shared children on each path and serializes finite sharing", async () => {
    const shared = { n: 1 };
    const updatedInput = { a: shared, b: shared };
    expect(isBoundedJsonShape(updatedInput)).toBe(true);
    expect(isClaudeHookInput(tool("mcp__server__tool", updatedInput))).toBe(true);
    const { outcome, errors, response } = await rewrite(updatedInput);
    expect(outcome.failedOpen).toBe(false);
    expect(errors).toEqual([]);
    expect(JSON.parse(response.stdout).hookSpecificOutput.updatedInput).toEqual(updatedInput);
    shared.n = Number.NaN;
    expect(isBoundedJsonShape(updatedInput)).toBe(false);
    const repeated = Array.from({ length: 50_000 }, () => ({}));
    expect(isBoundedJsonShape(repeated)).toBe(true);
    const repeatedWithValue = Array.from({ length: 50_000 }, () => ({ n: 1 }));
    expect(isBoundedJsonShape(repeatedWithValue)).toBe(false);
    const sameChild = Array.from({ length: 50_000 }, () => shared);
    shared.n = 1;
    expect(isBoundedJsonShape(sameChild.slice(0, 49_999))).toBe(true);
    expect(isBoundedJsonShape(sameChild)).toBe(false);
  });
});

async function rewrite(updatedInput: Record<string, unknown>) {
  const emitter = new TypedEmitter<ClaudeEventMap>();
  const errors: HookErrorEvent[] = [];
  emitter.on("hookError", (error) => errors.push(error));
  registerInitialHooks(emitter, {
    PreToolUse: { unknown: () => ({ permissionDecision: "allow" as const, updatedInput }) },
  } as never);
  const outcome = await requestHook(
    emitter,
    tool("mcp__server__tool", {}) as never,
    1_000,
    "sess-1",
  );
  return { outcome, errors, response: serializeHookResult("PreToolUse", outcome.result) };
}
