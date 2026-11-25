/** Verify that checked launch evidence rejects a linked-worktree redirect (C-ATTN-07). */
import * as fs from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { captureLaunchTrustEvidence } from "../../src/codex/workspace-trust/launch-evidence.ts";
import { codexRepositoryTrustRoot } from "../../src/codex/workspace-trust/repository.ts";
import { createLinkedCheckout, registerWorktree } from "../helpers/codex-trust-worktree.ts";
import { tempDir } from "../helpers/tmp.ts";

let root: string;
beforeEach(() => {
  root = fs.realpathSync(tempDir("elwood-codex-git-trust-"));
});

test("C-ATTN-07 revalidates Git linkage even when both root directory identities stay fixed", async () => {
  const { repo, checkout } = createLinkedCheckout(root);
  const alternate = join(root, "project");
  fs.mkdirSync(alternate);
  const originalInode = fs.statSync(repo, { bigint: true }).ino;
  const alternateInode = fs.statSync(alternate, { bigint: true }).ino;
  const { isCurrent } = await captureLaunchTrustEvidence({
    agent: "codex",
    cwd: checkout,
    identity: fs.statSync(checkout, { bigint: true }),
  });
  expect(await isCurrent()).toBe(true);

  registerWorktree(checkout, alternate);

  expect((await codexRepositoryTrustRoot(checkout))?.path).toBe(alternate);
  expect(fs.statSync(repo, { bigint: true }).ino).toBe(originalInode);
  expect(fs.statSync(alternate, { bigint: true }).ino).toBe(alternateInode);
  expect(await isCurrent()).toBe(false);
});
