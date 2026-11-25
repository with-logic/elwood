/** Verify the filesystem evidence for a Codex trust target (PRD §5.5). */
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { codexRepositoryTrustRoot } from "../../src/codex/workspace-trust/repository.ts";
import { registerWorktree } from "../helpers/codex-trust-worktree.ts";
import { tempDir } from "../helpers/tmp.ts";

vi.mock("node:fs", { spy: true });

let root: string;
beforeEach(() => {
  root = fs.realpathSync(tempDir("elwood-codex-git-trust-"));
});
afterEach(() => {
  vi.restoreAllMocks();
});

function linked() {
  const repo = join(root, "project ");
  const checkout = join(root, "checkout");
  fs.mkdirSync(checkout);
  return { repo, checkout, ...registerWorktree(checkout, repo) };
}

test("finds a valid ancestor beyond a nested empty Git directory", () => {
  const git = join(root, ".git");
  const child = join(root, "project");
  fs.mkdirSync(git);
  fs.writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
  fs.mkdirSync(join(child, ".git"), { recursive: true });
  expect(codexRepositoryTrustRoot(child)?.path).toBe(root);
});

test("requires the native worktree registration to point to this checkout", () => {
  const { repo, checkout, slot } = linked();
  expect(codexRepositoryTrustRoot(checkout)?.path).toBe(repo);
  fs.writeFileSync(join(slot, "gitdir"), `${join(root, ".git")}\n`);
  expect(() => codexRepositoryTrustRoot(checkout)).toThrow();
});

test("can resolve a registered linked checkout to its separately kept Git directory", () => {
  const { repo, checkout, slot, marker } = linked();
  const common = join(repo, "separate");
  fs.renameSync(join(repo, ".git"), common);
  fs.writeFileSync(join(repo, ".git"), "gitdir: separate\n");
  fs.writeFileSync(marker, `gitdir: ${slot.replace("/.git/", "/separate/")}\n`);
  expect(codexRepositoryTrustRoot(checkout)?.path).toBe(repo);
  fs.mkdirSync(join(repo, "unrelated"));
  fs.writeFileSync(join(repo, ".git"), "gitdir: unrelated\n");
  expect(() => codexRepositoryTrustRoot(checkout)).toThrow();
});

test.each([
  ["unrecognized syntax", "not-a-pointer"],
  ["empty pointer", "gitdir:\n"],
  ["empty marker", ""],
  ["oversize marker", "a".repeat(64 * 1024 + 1)],
])("withholds repository evidence for %s", (_scenario, contents) => {
  const { checkout, marker } = linked();
  fs.writeFileSync(marker, contents);
  expect(() => codexRepositoryTrustRoot(checkout)).toThrow();
});

test("rejects symlink markers and non-worktree directory layouts", () => {
  const { checkout, marker } = linked();
  const unrelated = join(root, "other");
  fs.mkdirSync(unrelated);
  fs.writeFileSync(marker, `gitdir: ${unrelated}\n`);
  expect(() => codexRepositoryTrustRoot(checkout)).toThrow();
  fs.writeFileSync(marker, "gitdir: .git\n");
  expect(() => codexRepositoryTrustRoot(checkout)).toThrow();
  fs.rmSync(marker);
  fs.symlinkSync(unrelated, marker);
  expect(() => codexRepositoryTrustRoot(checkout)).toThrow();
});

test("withholds evidence from special files and changing metadata", () => {
  const { checkout, slot } = linked();
  vi.mocked(fs.readSync).mockReturnValueOnce(0);
  expect(() => codexRepositoryTrustRoot(checkout)).toThrow();
  const common = join(slot, "commondir");
  fs.rmSync(common);
  fs.mkdirSync(common);
  expect(() => codexRepositoryTrustRoot(checkout)).toThrow();
});

test("C-CODEX-15 a positive short metadata read retains the verified root", async () => {
  const { checkout, repo } = linked();
  const original = (await vi.importActual<typeof fs>("node:fs")).readSync;
  vi.mocked(fs.readSync).mockImplementationOnce((...args) =>
    Reflect.apply(original, undefined, [args[0], args[1], 0, 1, 0]),
  );
  expect(codexRepositoryTrustRoot(checkout)?.path).toBe(repo);
});

test("C-CODEX-15 metadata that grows after fstat withholds the root", async () => {
  const { checkout, marker } = linked();
  const original = (await vi.importActual<typeof fs>("node:fs")).readSync;
  vi.mocked(fs.readSync).mockImplementationOnce((...args) => {
    fs.appendFileSync(marker, "\n");
    return Reflect.apply(original, undefined, args);
  });
  expect(() => codexRepositoryTrustRoot(checkout)).toThrow();
});
