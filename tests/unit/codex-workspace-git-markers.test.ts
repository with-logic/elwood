/** Exercise bounded Codex Git markers independently of native input (PRD §5.5). */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { codexRepositoryTrustRoot } from "../../src/codex/workspace-trust/repository.ts";
import { tempDir } from "../helpers/tmp.ts";

vi.mock("node:fs/promises", { spy: true });

let root: string;
beforeEach(() => {
  root = fs.realpathSync(tempDir("elwood-codex-git-markers-"));
});
afterEach(() => {
  vi.restoreAllMocks();
});

function ordinaryExternalGit() {
  const git = join(root, "worktrees", "metadata");
  const checkout = join(root, "checkout");
  fs.mkdirSync(git, { recursive: true });
  fs.mkdirSync(checkout);
  fs.writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(join(checkout, ".git"), `gitdir: ${git}\n`);
  return { git, checkout };
}

test("recognizes an ordinary external Git directory whose parent is named worktrees", async () => {
  const { checkout } = ordinaryExternalGit();
  await expect(codexRepositoryTrustRoot(checkout)).resolves.toEqual({
    path: checkout,
    allowsFolderFallback: true,
  });
});

test.each([
  "gitdir",
  "commondir",
])("rejects an incomplete worktree registration with only %s", async (file) => {
  const { git, checkout } = ordinaryExternalGit();
  fs.writeFileSync(join(git, file), "../other\n");
  await expect(codexRepositoryTrustRoot(checkout)).rejects.toThrow();
});

test.each([40, 64])("accepts a detached HEAD with a %i-character object ID", async (length) => {
  const git = join(root, ".git");
  fs.mkdirSync(git);
  fs.writeFileSync(join(git, "HEAD"), `${"a".repeat(length)}\n`);
  await expect(codexRepositoryTrustRoot(root)).resolves.toEqual({
    path: root,
    allowsFolderFallback: false,
  });
});

test("rejects an oversized Git marker before reading its bytes", async () => {
  const marker = join(root, ".git");
  fs.writeFileSync(marker, "a".repeat(64 * 1024 + 1));
  const original = (await vi.importActual<typeof fsp>("node:fs/promises")).open;
  const read = vi.fn();
  vi.mocked(fsp.open).mockImplementationOnce(async (...options) => {
    const file = await original(...options);
    vi.spyOn(file, "read").mockImplementation(read);
    return file;
  });
  await expect(codexRepositoryTrustRoot(root)).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
});

test("does not treat an invalid intermediate directory as a missing Git marker", async () => {
  const { checkout } = ordinaryExternalGit();
  const regular = join(root, "regular");
  fs.writeFileSync(regular, "file");
  fs.writeFileSync(join(checkout, ".git"), `gitdir: ${regular}/git\n`);
  await expect(codexRepositoryTrustRoot(checkout)).rejects.toMatchObject({ code: "ENOTDIR" });
});
