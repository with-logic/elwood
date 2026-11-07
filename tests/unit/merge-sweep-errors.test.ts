/** Force and graceful sweep failures remain jointly diagnosable (PRD §9.4, C-LIFE-10). */
import { expect, test } from "vitest";
import { mergeSweepErrors } from "../../src/runtime/shutdown/merge-sweep-errors.ts";

test("C-LIFE-10 a lone or repeated failure retains its original identity", () => {
  const later = new Error("survivor failed");
  expect(mergeSweepErrors(undefined, later)).toBe(later);
  expect(mergeSweepErrors(later, later)).toBe(later);
});

test("C-LIFE-10 merged failures retain both causes, the first errno, and bounded unique groups", () => {
  const groups = Array.from({ length: 24 }, (_, index) => 5000 + index);
  const first = Object.assign(new Error("force failed"), { code: "EIO", processGroupIds: groups });
  const later = Object.assign(new Error("survivor failed"), {
    code: "EPERM",
    processGroupIds: [5000, 6000],
  });
  const merged = mergeSweepErrors(first, later);
  expect(merged).toBeInstanceOf(AggregateError);
  expect(merged).toMatchObject({
    message: "force failed; survivor failed",
    errors: [first, later],
    code: "EIO",
    processGroupIds: groups.slice(0, 16),
  });
});

test("C-LIFE-10 later errno is preserved when the first cause has none", () => {
  expect(
    mergeSweepErrors("force failed", Object.assign(new Error("later"), { code: "ESRCH" })),
  ).toMatchObject({ code: "ESRCH", processGroupIds: [] });
});

test.each([
  undefined,
  "secret-path",
])("C-LIFE-10 missing or invalid errno %s is not exposed", (code) => {
  const first = Object.assign(new Error("force failed"), { code });
  const merged = mergeSweepErrors(first, new Error("later"));
  expect("code" in merged).toBe(false);
  expect(merged).toMatchObject({ errors: [first, expect.any(Error)] });
});
