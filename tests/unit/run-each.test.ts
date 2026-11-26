/** `runEach` runs every step, then rethrows the first failure (PRD §5.4, C-API-72). */
import { expect, test } from "vitest";
import { runEach } from "../../src/core/contained.ts";

test("C-API-72 runEach runs every step after a failure, then rethrows the first", () => {
  const first = new Error("first");
  const ran: string[] = [];
  const fail = (name: string, error: unknown) => () => {
    ran.push(name);
    throw error;
  };
  expect(() => runEach(fail("a", first), () => ran.push("b"), fail("c", new Error("c")))).toThrow(
    first,
  );
  expect(ran).toEqual(["a", "b", "c"]);
});

test("C-API-72 runEach rethrows a first failure that is undefined", () => {
  let caught: unknown = "not thrown";
  try {
    runEach(() => {
      // biome-ignore lint/style/useThrowOnlyError: a listener may throw any value.
      throw undefined;
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeUndefined();
});
