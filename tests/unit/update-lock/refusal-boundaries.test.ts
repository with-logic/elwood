/** Refusal authority expires before successor invocation (PRD §9.2, C-LIFE-09/11). */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { UpdateVerificationFailure } from "../../../src/core/update-verification.ts";
import { coordinatedAutoupdate, updateLockPath } from "../../../src/runtime/update/lock.ts";
import { tempDir } from "../../helpers/tmp.ts";

test("C-LIFE-09 refusal publication failure preserves its error and releases ownership", async () => {
  const root = tempDir("elwood-refusal-publication-");
  const failure = new UpdateVerificationFailure(undefined);
  await expect(
    coordinatedAutoupdate(
      "codex",
      () => {
        mkdirSync(join(root, "codex.completed.refused"));
        return Promise.reject(failure);
      },
      { root },
    ),
  ).rejects.toBe(failure);
  expect(existsSync(updateLockPath("codex", root))).toBe(false);
  expect(existsSync(join(root, "codex.completed"))).toBe(false);
});

test("C-LIFE-09 receipt invalidation failure prevents invocation and releases the successor", async () => {
  const root = tempDir("elwood-refusal-invalidation-");
  // unlink of a directory deterministically fails even under root.
  mkdirSync(join(root, "codex.completed.refused"));
  let attempts = 0;
  await expect(
    coordinatedAutoupdate("codex", () => Promise.resolve(void attempts++), { root }),
  ).rejects.toMatchObject({ code: expect.any(String) });
  expect(attempts).toBe(0);
  expect(existsSync(updateLockPath("codex", root))).toBe(false);
  expect(existsSync(join(root, "codex.completed"))).toBe(false);
});
