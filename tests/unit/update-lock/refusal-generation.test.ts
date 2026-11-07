/** Refusal authority belongs to the observed generation (PRD §9.2, C-LIFE-09). */

import "../../helpers/update-owner-observation.ts";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { UpdateVerificationFailure } from "../../../src/core/update-verification.ts";
import { readCompletionGeneration } from "../../../src/runtime/update/completion.ts";
import { coordinatedAutoupdate, updateLockPath } from "../../../src/runtime/update/lock.ts";
import {
  cachedAutoupdate,
  resetAutoupdateForTests,
  setUpdateCoordinatorForTests,
} from "../../../src/runtime/update/once.ts";
import { tempDir } from "../../helpers/tmp.ts";
import { observation } from "../../helpers/update-owner-observation.ts";

test.each([
  undefined,
  "00000000-0000-4000-8000-00000000000a",
])("C-LIFE-09 stale A receipt cannot authorize C after B refuses with completion %s", async (previous) => {
  const root = tempDir("elwood-refusal-successor-");
  const marker = join(root, "codex.completed");
  const receipt = `${marker}.refused`;
  if (previous !== undefined) writeFileSync(marker, previous);
  const failure = new UpdateVerificationFailure(undefined);
  const finish = Promise.withResolvers<void>();
  let entered = false;
  await expect(
    coordinatedAutoupdate("codex", () => Promise.reject(failure), { root }),
  ).rejects.toBe(failure);
  const refusedA = readFileSync(receipt, "utf8");
  const successor = coordinatedAutoupdate(
    "codex",
    async () => {
      expect(existsSync(receipt)).toBe(false);
      // A directory forces B's refusal receipt rename to fail, even when running as root.
      mkdirSync(receipt);
      entered = true;
      await finish.promise;
      throw failure;
    },
    { root, pollMs: 1, staleMs: 0, waitMs: 1_000 },
  );
  const successorSettled = expect(successor).rejects.toBe(failure);
  try {
    await expect.poll(() => entered, { timeout: 1_000 }).toBe(true);
    observation.ownerPath = join(updateLockPath("codex", root), "owner");
    observation.observed = false;
    observation.afterRead = async () => {
      // C has read B's live owner; B must release before the stale A receipt is restored.
      finish.resolve();
      await successorSettled;
      rmSync(receipt, { recursive: true });
      writeFileSync(receipt, refusedA);
    };
    resetAutoupdateForTests();
    setUpdateCoordinatorForTests((adapter, update) =>
      coordinatedAutoupdate(adapter, update, { root, pollMs: 1, staleMs: 0, waitMs: 1_000 }),
    );
    let attempts = 0;
    const outcome = await cachedAutoupdate("codex", () => Promise.resolve(void attempts++));
    expect(observation.observed).toBe(true);
    expect(await readCompletionGeneration(marker)).toBe(previous);
    expect(readFileSync(receipt, "utf8")).toBe(refusedA);
    expect(outcome).toEqual({ ok: true });
    expect(await cachedAutoupdate("codex", () => Promise.resolve(void attempts++))).toBe(outcome);
    expect(attempts).toBe(0);
  } finally {
    observation.afterRead = undefined;
    finish.resolve();
    await successorSettled;
  }
});
