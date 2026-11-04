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

test.each([
  false,
  true,
])("C-LIFE-09 fifty callers allow one successor when verification recovers (%s)", async (transient) => {
  const refusal = new Error("controlled verification failure");
  const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  let healthy = false;
  let verifications = 0;
  const coordinate = vi.fn((_adapter: UpdateAdapter, update: UpdateOperation) => update());
  setUpdateCoordinatorForTests(coordinate);
  const steps = {
    verify: async () => {
      const index = verifications++;
      await release[index]?.promise;
      if (!(healthy || (transient && index > 0))) throw refusal;
    },
    update: vi.fn(async () => {}),
  };
  const owner = cachedAutoupdate("codex", steps);
  const pending = [owner];
  try {
    await vi.waitFor(() => expect(verifications).toBe(1));
    const callers = Array.from({ length: 48 }, () => cachedAutoupdate("codex", steps));
    pending.push(...callers);
    const settled = Promise.all([...pending]);
    release[0]?.resolve();
    await vi.waitFor(() => expect(verifications).toBe(2));
    // A caller arriving during the successor inherits its exhausted retry budget.
    const successorJoiner = cachedAutoupdate("codex", steps);
    pending.push(successorJoiner);
    release[1]?.resolve();
    const outcomes = await settled;
    const noAttempt = { ok: false, error: refusal, notStarted: true };
    expect(outcomes[0]).toEqual(noAttempt);
    expect(outcomes.slice(1)).toEqual(
      Array.from({ length: 48 }, () => (transient ? { ok: true } : noAttempt)),
    );
    expect(await successorJoiner).toEqual(transient ? { ok: true } : noAttempt);
    expect(coordinate).toHaveBeenCalledTimes(2);
    expect(verifications).toBe(2);
    expect(steps.update).toHaveBeenCalledTimes(transient ? 1 : 0);
    healthy = true;
    expect(await cachedAutoupdate("codex", steps)).toEqual({ ok: true });
    expect(coordinate).toHaveBeenCalledTimes(transient ? 2 : 3);
    expect(steps.update).toHaveBeenCalledTimes(1);
  } finally {
    for (const gate of release) gate.resolve();
    await Promise.allSettled(pending);
  }
});
