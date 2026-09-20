/** Detached data, serialization safety, and bounded traversal (PRD §6.4, C-HOOK-21). */
import { expect, test } from "vitest";
import { type JsonSnapshot, snapshotJsonData } from "../../src/core/json-snapshot.ts";

function nested(depth: number): object {
  let value: object = {};
  for (let index = 0; index < depth; index += 1) value = { value };
  return value;
}
const cycle: Record<string, unknown> = {};
cycle["self"] = cycle;
const boxed = new Object(Number.POSITIVE_INFINITY);
Object.setPrototypeOf(boxed, null);

test.each([
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  1n,
  Symbol("x"),
  () => 1,
  boxed,
  new Date(),
  new Proxy(
    {},
    {
      get() {
        throw new Error("never invoke");
      },
    },
  ),
  cycle,
  nested(129),
  Object.defineProperty({}, "toJSON", {
    get() {
      throw new Error("never invoke");
    },
  }),
  Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      throw new Error("never invoke");
    },
  }),
])("C-HOOK-21 rejects unsafe data without executing it: %#", (value) => {
  expect(snapshotJsonData(value)).toEqual({ valid: false });
});

test("C-HOOK-21 snapshots supported data and preserves ordinary toJSON fields", () => {
  const shared = { text: "ok", yes: true, no: false, absent: undefined, empty: null, number: 1 };
  const array: unknown[] = new Array(3);
  array[0] = shared;
  array[2] = undefined;
  const source = { a: shared, b: shared, array, toJSON: "data" };
  const result = snapshotJsonData(source);
  expect(result.valid).toBe(true);
  if (!result.valid) throw new Error("expected snapshot");
  expect(JSON.stringify(result.value)).toBe(JSON.stringify(source));
  shared.text = "changed";
  expect(JSON.stringify(result.value)).not.toContain("changed");
  for (const toJSON of [undefined, 7, null])
    expect(snapshotJsonData({ toJSON })).toEqual({ valid: true, value: { toJSON } });
});

test("C-HOOK-21 ignores non-enumerable fields and avoids prototype pollution", () => {
  const source = JSON.parse('{"__proto__":{"polluted":true},"constructor":"data"}');
  Object.defineProperty(source, "hidden", {
    get() {
      throw new Error("not JSON data");
    },
  });
  Object.defineProperty(Object.prototype, "inheritedFixture", {
    enumerable: true,
    configurable: true,
    value: 1,
  });
  let result: JsonSnapshot;
  try {
    result = snapshotJsonData(source);
  } finally {
    Reflect.deleteProperty(Object.prototype, "inheritedFixture");
  }
  expect(result).toEqual({ valid: true, value: source });
  expect(snapshotJsonData(Object.assign(Object.create(null), { value: 1 }))).toEqual({
    valid: true,
    value: { value: 1 },
  });
});

test("C-HOOK-21 enforces exact depth and visit boundaries for arrays and records", () => {
  expect(snapshotJsonData(nested(128)).valid).toBe(true);
  expect(snapshotJsonData(Array.from({ length: 99_999 }, () => 1)).valid).toBe(true);
  expect(snapshotJsonData(Array.from({ length: 100_000 }, () => 1)).valid).toBe(false);
  const record = Object.fromEntries(Array.from({ length: 100_000 }, (_, i) => [i, 1]));
  expect(snapshotJsonData(record).valid).toBe(false);
  expect(snapshotJsonData([Symbol("not JSON")]).valid).toBe(false);
});

test("C-HOOK-21 counts every occurrence of shared children toward the visit limit", () => {
  const shared = { value: 1 };
  const withinBudget = [...Array.from({ length: 49_999 }, () => shared), 0];
  expect(snapshotJsonData(withinBudget).valid).toBe(true);
  expect(snapshotJsonData([...withinBudget, shared]).valid).toBe(false);
});

test("C-HOOK-21 ignores a hidden non-callable toJSON data field", () => {
  const source = Object.defineProperty({ value: 1 }, "toJSON", { value: 7 });
  expect(snapshotJsonData(source)).toEqual({ valid: true, value: { value: 1 } });
});

test.each([
  true,
  false,
])("C-HOOK-21 callable serializer enumerable=%s is rejected without invocation", (enumerable) => {
  let calls = 0;
  const value = Object.defineProperty({}, "toJSON", {
    enumerable,
    value: () => {
      calls += 1;
      throw new Error("must not invoke");
    },
  });
  expect(snapshotJsonData(value)).toEqual({ valid: false });
  expect(calls).toBe(0);
});

test.each([
  "holes",
  "undefined",
] as const)("C-HOOK-21 counts every %s array slot at the exact visit boundary", (kind) => {
  const within: undefined[] = new Array(99_999);
  const beyond: undefined[] = new Array(100_000);
  if (kind === "undefined") {
    within.fill(undefined);
    beyond.fill(undefined);
  }
  expect(snapshotJsonData(within).valid).toBe(true);
  expect(snapshotJsonData(beyond).valid).toBe(false);
});
