/** One contention wait serves current callers, while later calls may recover (PRD §9.2, C-LIFE-09). */
import { expect, test, vi } from "vitest";
import { elwoodError } from "../../src/core/errors.ts";
import { updateSkipMessages } from "../../src/core/warnings/update-skips.ts";
import type { UpdateAdapter } from "../../src/runtime/update/lock.ts";
import type { UpdateOperation } from "../../src/runtime/update/not-started.ts";
import { cachedAutoupdate, setUpdateCoordinatorForTests } from "../../src/runtime/update/once.ts";

test.each([
  ...Object.keys(updateSkipMessages),
  "unavailable",
  "actual-failure",
])("C-LIFE-09 ten current callers share one %s outcome; only a later call retries", async (kind) => {
  const failedAttempt = kind === "actual-failure";
  const failure = elwoodError("codex_update_failed", "controlled coordination outcome", {
    ...(failedAttempt ? {} : { updateReason: kind }),
  });
  let recovered = false;
  const coordinate = vi.fn(async (_adapter: UpdateAdapter, update: UpdateOperation) => {
    if (recovered) return update();
    // A short real bound models the single expensive production contention wait.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    if (kind === "unavailable") return { started: false } as const;
    if (failedAttempt) return update();
    throw failure;
  });
  setUpdateCoordinatorForTests(coordinate);
  const verify = vi.fn(async () => true);
  const update = vi.fn(() => (recovered ? Promise.resolve() : Promise.reject(failure)));
  const expected = {
    ok: false,
    error: kind === "unavailable" ? undefined : failure,
    ...(failedAttempt ? {} : { notStarted: true }),
  };
  const cohort = Array.from({ length: 10 }, () => cachedAutoupdate("codex", { verify, update }));
  expect(await Promise.all(cohort)).toEqual(Array.from({ length: 10 }, () => expected));
  expect(coordinate).toHaveBeenCalledTimes(1);
  expect(verify).toHaveBeenCalledTimes(failedAttempt ? 1 : 0);
  expect(update).toHaveBeenCalledTimes(failedAttempt ? 1 : 0);
  recovered = true;
  expect(await cachedAutoupdate("codex", { verify, update })).toEqual(
    failedAttempt ? expected : { ok: true },
  );
  expect(coordinate).toHaveBeenCalledTimes(failedAttempt ? 1 : 2);
  expect(update).toHaveBeenCalledTimes(1);
});
