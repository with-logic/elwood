/** Hook rewrites reject values JSON would transform or execute (PRD §6.4, C-HOOK-18). */
import { expect, test } from "vitest";
import { requestHook } from "../../src/claude/hooks/dispatch.ts";
import { serializeHookResult } from "../../src/claude/serialize.ts";
import { registerInitialHooks } from "../../src/claude/session/runtime.ts";
import { isBoundedJsonShape } from "../../src/core/predicates.ts";
import type { ClaudeEventMap, HookErrorEvent } from "../../src/core/types.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";
import { tool } from "./claude-validate-input-helpers.ts";

const rejected = [
  ["bigint", 1n],
  ["boxed infinity", new Object(Number.POSITIVE_INFINITY)],
  ["boxed string", new Object("text")],
  ["function", () => 1],
  ["symbol", Symbol("value")],
  ["custom serializer", { toJSON: () => null }],
  ["date", new Date(0)],
  [
    "accessor",
    Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        throw new Error("never read");
      },
    }),
  ],
  [
    "throwing proxy",
    new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("invalid shape");
        },
      },
    ),
  ],
] as const;

test.each(
  rejected,
)("C-HOOK-18 %s rewrite reports invalid_response before serialization", async (_label, value) => {
  const emitter = new TypedEmitter<ClaudeEventMap>();
  const errors: HookErrorEvent[] = [];
  emitter.on("hookError", (error) => errors.push(error));
  registerInitialHooks(emitter, {
    PreToolUse: {
      unknown: () => ({ permissionDecision: "allow" as const, updatedInput: { value } }),
    },
  } as never);
  const outcome = await requestHook(
    emitter,
    tool("mcp__server__tool", {}) as never,
    1_000,
    "sess-1",
  );
  expect(outcome.failedOpen).toBe(true);
  expect(outcome.result).toBeUndefined();
  expect(errors.map((error) => error.category)).toEqual(["invalid_response"]);
  expect(serializeHookResult("PreToolUse", outcome.result)).toEqual({
    exitCode: 0,
    stdout: "",
    stderr: "",
  });
});

test("C-HOOK-18 stops inspecting wide record values when the visit budget is spent", () => {
  const value = Object.fromEntries(Array.from({ length: 100_000 }, (_, i) => [`field${i}`, 1]));
  let lateReads = 0;
  Object.defineProperty(value, "late", {
    enumerable: true,
    get() {
      lateReads += 1;
      throw new Error("past budget");
    },
  });
  expect(isBoundedJsonShape(value)).toBe(false);
  expect(lateReads).toBe(0);
});

test("C-HOOK-18 never invokes hidden serializers or accessors", () => {
  let calls = 0;
  const custom = Object.defineProperty({}, "toJSON", {
    value: () => {
      calls += 1;
      return null;
    },
  });
  const accessor = Object.defineProperty({}, "value", {
    enumerable: true,
    get: () => {
      calls += 1;
      return 1;
    },
  });
  expect(isBoundedJsonShape(custom)).toBe(false);
  expect(isBoundedJsonShape(accessor)).toBe(false);
  expect(calls).toBe(0);
});

test("C-HOOK-18 accepts plain and null-prototype records without inherited properties", () => {
  const value = Object.assign(Object.create(null), { number: 3, nested: { label: "ok" } });
  Object.defineProperty(Object.prototype, "elwoodInheritedFixture", {
    enumerable: true,
    configurable: true,
    value: Number.POSITIVE_INFINITY,
  });
  try {
    const valid = isBoundedJsonShape(value);
    Reflect.deleteProperty(Object.prototype, "elwoodInheritedFixture");
    expect(valid).toBe(true);
  } finally {
    Reflect.deleteProperty(Object.prototype, "elwoodInheritedFixture");
  }
});
