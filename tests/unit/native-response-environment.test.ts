/** Native response proof detects environment drift without secret-bearing diagnostics. */
import { inspect } from "node:util";
import { expect, test } from "vitest";
import { assertParentEnvironmentUnchanged } from "../e2e/codex-response-sandbox.ts";

const canary = "SYNTHETIC_PARENT_ENV_SECRET_CANARY";
const before = { TOKEN: canary, OPTIONAL: undefined };

test("unchanged parent environment accepts reordered keys", () => {
  expect(() =>
    assertParentEnvironmentUnchanged(before, { OPTIONAL: undefined, TOKEN: canary }),
  ).not.toThrow();
  expect(() => assertParentEnvironmentUnchanged({}, {})).not.toThrow();
});

test.each([
  { name: "added", after: { ...before, ADDED: canary } },
  { name: "removed", after: { OPTIONAL: undefined } },
  { name: "changed", after: { ...before, TOKEN: `${canary}_changed` } },
  { name: "renamed", after: { RENAMED: canary, OPTIONAL: undefined } },
  { name: "added undefined", after: { ...before, ADDED: undefined } },
  { name: "removed undefined", after: { TOKEN: canary } },
  { name: "renamed undefined", after: { TOKEN: canary, RENAMED: undefined } },
])("$name parent variable rejects without exposing its value", ({ after }) => {
  let failure: unknown;
  try {
    assertParentEnvironmentUnchanged(before, after);
  } catch (error) {
    failure = error;
  }
  // Boolean assertions keep even a broken redaction helper from printing the canary.
  expect(failure instanceof Error).toBe(true);
  if (!(failure instanceof Error)) throw new Error("Expected environment drift to reject.");
  expect(failure.message === "Parent environment changed.").toBe(true);
  expect(inspect(failure, { showHidden: true }).includes(canary)).toBe(false);
});
