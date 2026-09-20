/** Hook snapshot descriptors and output remain inert under inherited properties (C-HOOK-21). */
import { expect, test } from "vitest";
import { serializeHookResult } from "../../src/claude/serialize.ts";
import { type JsonSnapshot, snapshotJsonData } from "../../src/core/json-snapshot.ts";

for (const key of ["field", "toJSON"]) {
  test(`C-HOOK-21 inherited descriptor value cannot disguise ${key} accessors`, () => {
    let reads = 0;
    const source = Object.defineProperty({}, key, {
      enumerable: true,
      get() {
        reads += 1;
      },
    });
    Object.defineProperty(Object.prototype, "value", {
      configurable: true,
      get() {
        reads += 1;
        return 1;
      },
    });
    let result: JsonSnapshot;
    try {
      result = snapshotJsonData(source);
    } finally {
      Reflect.deleteProperty(Object.prototype, "value");
    }
    expect(result).toEqual({ valid: false });
    expect(reads).toBe(0);
  });
}

test.each([
  Object.prototype,
  Array.prototype,
])("C-HOOK-21 inherited serializers cannot replace arrays or output envelopes: %#", (prototype) => {
  let calls = 0;
  const snapshot = snapshotJsonData({ values: [1, 2] });
  if (!snapshot.valid) throw new Error("expected valid snapshot");
  Object.defineProperty(prototype, "toJSON", {
    configurable: true,
    get() {
      calls += 1;
      return () => "replaced";
    },
  });
  let outputs: string[];
  try {
    outputs = [
      JSON.stringify(snapshot.value),
      serializeHookResult("PreToolUse", { permissionDecision: "allow" }).stdout,
      serializeHookResult("PermissionRequest", { behavior: "allow" }).stdout,
      serializeHookResult("Stop", {
        decision: "block",
        reason: "wait",
        additionalContext: "context",
      }).stdout,
      serializeHookResult("Notification", { continue: false }).stdout,
      serializeHookResult("PostToolUseFailure", { retry: true }).stdout,
    ];
  } finally {
    Reflect.deleteProperty(prototype, "toJSON");
  }
  expect(calls).toBe(0);
  expect(outputs.map((output) => JSON.parse(output))).toEqual([
    { values: [1, 2] },
    { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } },
    { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } },
    {
      decision: "block",
      reason: "wait",
      hookSpecificOutput: { hookEventName: "Stop", additionalContext: "context" },
    },
    { continue: false },
    { hookSpecificOutput: { hookEventName: "PostToolUseFailure", retry: true } },
  ]);
});
