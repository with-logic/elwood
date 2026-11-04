/** Malformed or unpublishable affirmation remains conservative (PRD §9.2, C-PERF-04). */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { buildUpdateWarning } from "../../../src/core/warnings/update.ts";
import {
  completionReceiptPath,
  completionSnapshot,
  observePeerCompletion,
  serializeCompletionReceipt,
} from "../../../src/runtime/update/completion.ts";
import { coordinatedAutoupdate, updateLockPath } from "../../../src/runtime/update/lock.ts";
import { tempDir } from "../../helpers/tmp.ts";

const fault = vi.hoisted(() => ({ marker: "", fired: false }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (String(args[1]) === fault.marker && String(args[0]).endsWith(".acknowledged")) {
        fault.fired = true;
        // A real directory blocks replacement after the receipt and raw token were checked.
        await actual.rename(args[1], `${fault.marker}.preserved`);
        await actual.mkdir(args[1]);
      }
      return await actual.rename(...args);
    },
  };
});
afterEach(() => Object.assign(fault, { marker: "", fired: false }));

test("C-PERF-04 an empty versioned receipt never confirms an observed generation", async () => {
  const root = tempDir("elwood-empty-completion-");
  const lease = updateLockPath("codex", root);
  const marker = join(root, "codex.completed");
  mkdirSync(lease);
  writeFileSync(join(lease, "owner"), `${process.pid}:a`);
  writeFileSync(marker, "a");
  writeFileSync(completionReceiptPath(marker), serializeCompletionReceipt(""));
  const snapshot = await completionSnapshot(lease, marker);
  expect(snapshot.ownerAlreadyCompleted).toBe(false);
  expect(snapshot.mismatchedReceipt).toBeUndefined();
  expect(await observePeerCompletion(snapshot, new Set(["a"]), marker)).toBe("unconfirmed");
});

test("C-PERF-04 failed raw promotion still warns and never runs a duplicate updater", async () => {
  const root = tempDir("elwood-failed-completion-promotion-");
  const marker = join(root, "codex.completed");
  const receipt = completionReceiptPath(marker);
  writeFileSync(marker, "a");
  writeFileSync(receipt, serializeCompletionReceipt("b"));
  fault.marker = marker;
  const update = vi.fn(() => Promise.resolve());
  const outcome = await coordinatedAutoupdate("codex", update, { root }).catch(
    (error: unknown) => error,
  );
  expect(fault.fired).toBe(true);
  expect(update).not.toHaveBeenCalled();
  expect(outcome).toMatchObject({
    code: "codex_update_failed",
    details: { updateOutcome: "unconfirmed" },
  });
  expect(readFileSync(`${marker}.preserved`, "utf8")).toBe("a");
  expect(statSync(marker).isDirectory()).toBe(true);
  expect(readFileSync(receipt, "utf8")).toBe(serializeCompletionReceipt("b"));
  expect(existsSync(updateLockPath("codex", root))).toBe(false);
  const warning = buildUpdateWarning("codex", "0.150.0", outcome);
  expect(warning).toMatchObject({ errorCode: "update_unconfirmed", raw: "" });
  expect(warning).not.toHaveProperty("exitStatus");
  expect(JSON.stringify(warning)).not.toContain(root);
});
