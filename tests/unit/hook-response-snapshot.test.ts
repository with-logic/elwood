/** Hook dispatch validates and serializes detached data (PRD §6.4, C-HOOK-21). */
import { expect, test } from "vitest";
import { requestHook } from "../../src/claude/hooks/dispatch.ts";
import { serializeHookResult } from "../../src/claude/serialize.ts";
import { registerInitialHooks } from "../../src/claude/session/runtime.ts";
import type { ClaudeEventMap, HookErrorEvent } from "../../src/core/types.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";
import { tool } from "./claude-validate-input-helpers.ts";

async function dispatch(value: unknown) {
  const emitter = new TypedEmitter<ClaudeEventMap>();
  const errors: HookErrorEvent[] = [];
  emitter.on("hookError", (event) => errors.push(event));
  registerInitialHooks(emitter, { PreToolUse: { unknown: () => value } } as never);
  const outcome = await requestHook(emitter, tool("mcp__server__tool", {}) as never, 1_000, "s1");
  return { outcome, errors };
}

test("C-HOOK-21 a handler cannot mutate the rewrite after validation", async () => {
  const updatedInput = { number: 1, array: ["before"] };
  const result = { permissionDecision: "allow", updatedInput };
  const { outcome, errors } = await dispatch(result);
  expect(errors).toEqual([]);
  expect(outcome.failedOpen).toBe(false);
  updatedInput.number = Number.POSITIVE_INFINITY;
  updatedInput.array[0] = "after";
  result.permissionDecision = "deny";
  expect(JSON.parse(serializeHookResult("PreToolUse", outcome.result).stdout)).toEqual({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { number: 1, array: ["before"] },
    },
  });
});

test.each([
  "updatedInput",
  "permissionDecision",
])("C-HOOK-21 accessor envelope field %s fails without invocation", async (key) => {
  let reads = 0;
  const result = Object.defineProperty({ permissionDecision: "allow" }, key, {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error("unvalidated envelope read");
    },
  });
  const { outcome, errors } = await dispatch(result);
  expect(reads).toBe(0);
  expect(errors.map((error) => error.category)).toEqual(["invalid_response"]);
  expect(outcome).toEqual({ result: undefined, failedOpen: true });
  expect(serializeHookResult("PreToolUse", outcome.result)).toEqual({
    exitCode: 0,
    stdout: "",
    stderr: "",
  });
});

test("C-HOOK-21 a proxy cannot replace the value between validation and serialization", async () => {
  let reads = 0;
  const updatedInput = new Proxy(
    { number: 1 },
    {
      get() {
        reads += 1;
        return Number.NaN;
      },
    },
  );
  const { outcome, errors } = await dispatch({ permissionDecision: "allow", updatedInput });
  expect(reads).toBe(0);
  expect(errors.map((error) => error.category)).toEqual(["invalid_response"]);
  expect(outcome.failedOpen).toBe(true);
});
