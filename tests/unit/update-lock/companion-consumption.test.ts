/** Partial completion cleanup preserves changed ownership/evidence (PRD §9.2, C-PERF-04). */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  completionReceiptPath,
  completionSnapshot,
  consumeMismatchedReceipt,
  serializeCompletionReceipt,
} from "../../../src/runtime/update/completion.ts";
import { tempDir } from "../../helpers/tmp.ts";

function fileState(path: string) {
  if (!existsSync(path)) return undefined;
  const { dev, ino } = statSync(path, { bigint: true });
  return { contents: readFileSync(path, "utf8"), dev, ino };
}

test.each([
  "no mismatch",
  "changed owner",
  "missing receipt",
  "replaced receipt inode",
  "changed receipt contents",
  "raw already promoted",
] as const)("C-PERF-04 partial completion consumption preserves %s", async (scenario) => {
  const root = tempDir("elwood-completion-consumption-");
  const lease = join(root, "codex.lock");
  const marker = join(root, "codex.completed");
  const receipt = completionReceiptPath(marker);
  const ownerPath = join(lease, "owner");
  const owner = { pid: process.pid, token: "consumer" };
  mkdirSync(lease);
  writeFileSync(ownerPath, `${owner.pid}:${owner.token}`);
  writeFileSync(marker, scenario === "no mismatch" ? "b" : "a");
  writeFileSync(receipt, serializeCompletionReceipt("b"));
  const snapshot = await completionSnapshot(lease, marker);
  if (scenario === "changed owner") writeFileSync(ownerPath, `${process.pid}:successor`);
  if (scenario === "missing receipt") unlinkSync(receipt);
  if (scenario === "replaced receipt inode") {
    renameSync(receipt, join(root, "captured-receipt"));
    writeFileSync(receipt, serializeCompletionReceipt("b"));
    expect(statSync(receipt, { bigint: true }).ino).not.toBe(
      snapshot.mismatchedReceipt?.identity.ino,
    );
  }
  if (scenario === "changed receipt contents") {
    const original = statSync(receipt, { bigint: true });
    writeFileSync(receipt, serializeCompletionReceipt("different"));
    expect(statSync(receipt, { bigint: true }).ino).toBe(original.ino);
  }
  if (scenario === "raw already promoted") writeFileSync(marker, "b");
  const paths = [marker, receipt, ownerPath];
  const before = paths.map(fileState);
  const names = readdirSync(root, { recursive: true }).sort();
  await consumeMismatchedReceipt(snapshot, marker, lease, owner);
  expect(paths.map(fileState)).toEqual(before);
  expect(readdirSync(root, { recursive: true }).sort()).toEqual(names);
});
