/** Graceful SIGTERM is sent only while its original leader is verified held (C-LIFE-10). */
import { afterEach, expect, test, vi } from "vitest";
import { heldLeaderHarness as harness } from "../helpers/held-leader.ts";

afterEach(() => vi.restoreAllMocks());

test("C-LIFE-10 TERM is sent while the original leader is held, then its group resumes", async () => {
  const run = harness();
  await run.stop();
  expect(run.signals).toEqual([{ generation: "original", held: true }]);
  expect(run.operations).toEqual(["read", "stop", "read", "TERM", "continue"]);
});

test.each([
  "replaceAfterRead",
  "replaceOnStop",
] as const)("C-LIFE-10 a leader replaced at %s is resumed without receiving TERM", async (when) => {
  const run = harness({ [when]: true });
  await expect(run.stop()).rejects.toMatchObject({ code: "termination_failed" });
  expect(run.signals).toEqual([]);
  expect(run.operations).toContain("continue");
});

test("C-LIFE-10 a leader gone during its stop receives no TERM", async () => {
  const run = harness({ goneOnStop: true });
  await run.stop();
  expect(run.signals).toEqual([]);
  expect(run.operations).toEqual(["read", "stop", "read", "continue"]);
});
