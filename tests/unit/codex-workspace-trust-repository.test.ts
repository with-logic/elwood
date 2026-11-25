/** Verify the filesystem evidence for a Codex trust target (PRD §5.5). */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { captureLaunchTrustEvidence } from "../../src/codex/workspace-trust/launch-evidence.ts";
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

test("requires a valid HEAD marker when validating a direct Git directory", () => {
  const git = join(root, ".git");
  const head = join(git, "HEAD");
  fs.mkdirSync(head, { recursive: true });
  expect(() => codexRepositoryTrustRoot(root)).toThrow();
  fs.rmdirSync(head);
  const borrowed = join(root, "borrowed");
  fs.writeFileSync(borrowed, "ref: refs/heads/main\n");
  fs.symlinkSync(borrowed, head);
  expect(() => codexRepositoryTrustRoot(root)).toThrow();
  expect(fs.openSync).toHaveBeenCalledWith(head, expect.any(Number));
  const flags = vi.mocked(fs.openSync).mock.lastCall?.[1];
  expect(Number(flags) & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
  expect(Number(flags) & fs.constants.O_NONBLOCK).toBe(fs.constants.O_NONBLOCK);
});

test("preserves significant trailing bytes in an external Git directory path", () => {
  const git = join(root, "external ");
  const checkout = join(root, "checkout");
  fs.mkdirSync(git);
  fs.mkdirSync(checkout);
  fs.writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(join(checkout, ".git"), `gitdir: ${git}\r\n`);
  expect(codexRepositoryTrustRoot(checkout)).toEqual({
    path: checkout,
    allowsFolderFallback: true,
  });
});

test("follows dot-dot after a parent symlink using native filesystem resolution", () => {
  const checkout = join(root, "checkout");
  const parent = join(root, "physical");
  const jump = join(parent, "jump");
  const repo = join(parent, "repo");
  fs.mkdirSync(checkout);
  fs.mkdirSync(jump, { recursive: true });
  const { marker } = registerWorktree(checkout, repo);
  fs.symlinkSync(jump, join(checkout, "shortcut"));
  fs.writeFileSync(marker, "gitdir: shortcut/../repo/.git/worktrees/test\n");

  expect(codexRepositoryTrustRoot(checkout)?.path).toBe(repo);
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

test("keeps only the launch folder for a registered worktree with an external common directory", () => {
  const main = join(root, "main");
  const checkout = join(root, "checkout");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      env: { PATH: process.env["PATH"], GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      stdio: "ignore",
    });
  git("init", "--separate-git-dir", join(root, "external.git"), main);
  const identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];
  git("-C", main, ...identity, "commit", "--allow-empty", "--no-gpg-sign", "-m", "Fixture");
  git("-C", main, "worktree", "add", "--detach", checkout);

  const evidence = captureLaunchTrustEvidence({
    agent: "codex",
    cwd: checkout,
    identity: fs.statSync(checkout, { bigint: true }),
  });
  expect(evidence.isCurrent()).toBe(true);
  expect(evidence.targets.map(({ target }) => target)).toEqual([
    { targetPath: checkout, targetScope: "folder" },
  ]);
});

test.each([
  ["unrecognized syntax", "not-a-pointer"],
  ["empty pointer", "gitdir:\n"],
  ["empty path with valid prefix", "gitdir: \n"],
  ["empty marker", ""],
  ["multiline marker", "gitdir: nested\ntrailing\n"],
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
