/**
 * Cleanup keeps an awaited draft's consumption check for as long as the draft stays pending,
 * so the check must not keep the prompt reachable through its staged predicate (PRD §5.3,
 * C-API-56).
 */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import { preparePasteNudges } from "../../src/core/input/paste-nudge.ts";

/** Prepare one write whose staged predicate holds its payload, as Codex's does. */
function enteredCheck() {
  const staged: WeakRef<object>[] = [];
  const nudges = preparePasteNudges(
    { sendInput: async () => undefined, settled: async () => undefined },
    {
      prepareStaged: (payload) => {
        const held = { payload };
        staged.push(new WeakRef(held));
        return () => held.payload.length > 0;
      },
      emptyFrame: () => undefined,
    },
    "hello",
    undefined,
    1_000,
    undefined,
  );
  return { check: nudges?.enteredInputConsumed, staged };
}

test("C-API-56 cleanup's consumption check keeps no staged payload reachable", async () => {
  setFlagsFromString("--expose-gc");
  const collect = runInNewContext("gc") as () => void;
  const { check, staged } = enteredCheck();
  expect(staged).toHaveLength(1);
  // A WeakRef keeps its target until the job that created it ends.
  await new Promise((resolve) => setImmediate(resolve));
  collect();
  expect(staged[0]?.deref()).toBeUndefined();
  expect(check?.()).toBe(false);
});
