/** Refusal authority expires before successor invocation (PRD §9.2, C-LIFE-09/11). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { UpdateVerificationFailure } from "../../../src/core/update-verification.ts";
import { coordinatedAutoupdate, updateLockPath } from "../../../src/runtime/update/lock.ts";
import { ownerFile, serializeOwner } from "../../../src/runtime/update/owner.ts";
import { FAKE_PID } from "../../helpers/fake-pid.ts";
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

test("C-LIFE-09 a recovered dead owner shares its published verification refusal", async () => {
  const root = tempDir("elwood-refusal-dead-owner-");
  const options = { root, pollMs: 1, staleMs: 0 };
  const failure = new UpdateVerificationFailure(undefined);
  await expect(coordinatedAutoupdate("codex", () => Promise.reject(failure), options)).rejects.toBe(
    failure,
  );
  const receipt = join(root, "codex.completed.refused");
  const generation = readFileSync(receipt, "utf8");
  const lease = updateLockPath("codex", root);
  // Reconstruct only the crash boundary after real refusal publication and before
  // release: this same generation's durable lease remains, but its owner has died.
  mkdirSync(lease);
  writeFileSync(join(lease, ownerFile), serializeOwner({ pid: FAKE_PID, token: generation }));
  let attempts = 0;
  const update = () => Promise.resolve(void attempts++);
  await expect(coordinatedAutoupdate("codex", update, options)).rejects.toMatchObject({
    code: "codex_update_failed",
    details: { updateReason: "peer_verification_refused" },
  });
  expect(attempts).toBe(0);
  expect(existsSync(lease)).toBe(false);
  expect(readFileSync(receipt, "utf8")).toBe(generation);
  expect(existsSync(join(root, "codex.completed"))).toBe(false);
  await coordinatedAutoupdate("codex", update, options);
  expect(attempts).toBe(1);
  expect(existsSync(receipt)).toBe(false);
});
