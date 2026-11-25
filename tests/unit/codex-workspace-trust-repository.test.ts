/** Verify the filesystem evidence for a Codex trust target (PRD §5.5). */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { captureLaunchTrustEvidence } from "../../src/codex/workspace-trust/launch-evidence.ts";
import { codexRepositoryTrustRoot } from "../../src/codex/workspace-trust/repository.ts";
import { createLinkedCheckout, registerWorktree } from "../helpers/codex-trust-worktree.ts";
import { tempDir } from "../helpers/tmp.ts";

vi.mock("node:fs/promises", { spy: true });

let root: string;
beforeEach(() => {
  root = fs.realpathSync(tempDir("elwood-codex-git-trust-"));
});
afterEach(() => {
  vi.restoreAllMocks();
});

test("finds a valid ancestor beyond a nested empty Git directory", async () => {
  const git = join(root, ".git");
  const child = join(root, "project");
  fs.mkdirSync(git);
  fs.writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
  fs.mkdirSync(join(child, ".git"), { recursive: true });
  expect((await codexRepositoryTrustRoot(child))?.path).toBe(root);
});

test("requires a valid HEAD marker when validating a direct Git directory", async () => {
  const git = join(root, ".git");
  const head = join(git, "HEAD");
  fs.mkdirSync(head, { recursive: true });
  await expect(codexRepositoryTrustRoot(root)).rejects.toThrow();
  fs.rmdirSync(head);
  const borrowed = join(root, "borrowed");
  fs.writeFileSync(borrowed, "ref: refs/heads/main\n");
  fs.symlinkSync(borrowed, head);
  await expect(codexRepositoryTrustRoot(root)).rejects.toThrow();
  expect(fsp.open).toHaveBeenCalledWith(head, expect.any(Number));
  const flags = vi.mocked(fsp.open).mock.lastCall?.[1];
  expect(Number(flags) & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
  expect(Number(flags) & fs.constants.O_NONBLOCK).toBe(fs.constants.O_NONBLOCK);
});

test("rejects a ref-shaped HEAD containing invalid UTF-8", async () => {
  const git = join(root, ".git");
  fs.mkdirSync(git);
  const head = Buffer.concat([Buffer.from("ref: refs/heads/"), Buffer.from([0xff, 0x0a])]);
  fs.writeFileSync(join(git, "HEAD"), head);
  await expect(codexRepositoryTrustRoot(root)).rejects.toThrow(TypeError);
});

test("preserves significant trailing bytes in an external Git directory path", async () => {
  const git = join(root, "external ");
  const checkout = join(root, "checkout");
  fs.mkdirSync(git);
  fs.mkdirSync(checkout);
  fs.writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(join(checkout, ".git"), `gitdir: ${git}\r\n`);
  await expect(codexRepositoryTrustRoot(checkout)).resolves.toEqual({
    path: checkout,
    allowsFolderFallback: true,
  });
});

test("follows dot-dot after a parent symlink using native filesystem resolution", async () => {
  const checkout = join(root, "checkout");
  const parent = join(root, "physical");
  const jump = join(parent, "jump");
  const repo = join(parent, "repo");
  fs.mkdirSync(checkout);
  fs.mkdirSync(jump, { recursive: true });
  const { marker } = registerWorktree(checkout, repo);
  fs.symlinkSync(jump, join(checkout, "shortcut"));
  fs.writeFileSync(marker, "gitdir: shortcut/../repo/.git/worktrees/test\n");

  expect((await codexRepositoryTrustRoot(checkout))?.path).toBe(repo);
});

test("requires the native worktree registration to point to this checkout", async () => {
  const { repo, checkout, slot } = createLinkedCheckout(root);
  expect((await codexRepositoryTrustRoot(checkout))?.path).toBe(repo);
  fs.writeFileSync(join(slot, "gitdir"), `${join(root, ".git")}\n`);
  await expect(codexRepositoryTrustRoot(checkout)).rejects.toThrow();
});

test("can resolve a registered linked checkout to its separately kept Git directory", async () => {
  const { repo, checkout, slot, marker } = createLinkedCheckout(root);
  const common = join(repo, "separate");
  fs.renameSync(join(repo, ".git"), common);
  fs.writeFileSync(join(repo, ".git"), "gitdir: separate\n");
  fs.writeFileSync(marker, `gitdir: ${slot.replace("/.git/", "/separate/")}\n`);
  expect((await codexRepositoryTrustRoot(checkout))?.path).toBe(repo);
  fs.mkdirSync(join(repo, "unrelated"));
  fs.writeFileSync(join(repo, ".git"), "gitdir: unrelated\n");
  await expect(codexRepositoryTrustRoot(checkout)).rejects.toThrow();
});

test("keeps only the launch folder for a registered worktree with an external common directory", async () => {
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

  const evidence = await captureLaunchTrustEvidence({
    agent: "codex",
    cwd: checkout,
    identity: fs.statSync(checkout, { bigint: true }),
  });
  await expect(evidence.isCurrent()).resolves.toBe(true);
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
])("withholds repository evidence for %s", async (_scenario, contents) => {
  const { checkout, marker } = createLinkedCheckout(root);
  fs.writeFileSync(marker, contents);
  await expect(codexRepositoryTrustRoot(checkout)).rejects.toThrow();
});

test("rejects symlink markers and non-worktree directory layouts", async () => {
  const { checkout, marker } = createLinkedCheckout(root);
  const unrelated = join(root, "other");
  fs.mkdirSync(unrelated);
  fs.writeFileSync(marker, `gitdir: ${unrelated}\n`);
  await expect(codexRepositoryTrustRoot(checkout)).rejects.toThrow();
  fs.writeFileSync(marker, "gitdir: .git\n");
  await expect(codexRepositoryTrustRoot(checkout)).rejects.toThrow();
  fs.rmSync(marker);
  fs.symlinkSync(unrelated, marker);
  await expect(codexRepositoryTrustRoot(checkout)).rejects.toThrow();
});

type PositionalGitRead = {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number; buffer: Buffer }>;
};

async function changeFirstRead(change: (file: PositionalGitRead) => void) {
  const original = (await vi.importActual<typeof fsp>("node:fs/promises")).open;
  vi.mocked(fsp.open).mockImplementationOnce(async (...options) => {
    const file = await original(...options);
    change(file);
    return file;
  });
}

test("withholds evidence from special files and changing metadata", async () => {
  const { checkout, slot } = createLinkedCheckout(root);
  await changeFirstRead((file) => {
    vi.spyOn(file, "read").mockResolvedValueOnce({ bytesRead: 0, buffer: Buffer.alloc(0) });
  });
  await expect(codexRepositoryTrustRoot(checkout)).rejects.toThrow();
  const common = join(slot, "commondir");
  fs.rmSync(common);
  fs.mkdirSync(common);
  await expect(codexRepositoryTrustRoot(checkout)).rejects.toThrow();
});

test("C-CODEX-15 a positive short metadata read retains the verified root", async () => {
  const { checkout, repo } = createLinkedCheckout(root);
  await changeFirstRead((file) => {
    const read = file.read.bind(file);
    vi.spyOn(file, "read").mockImplementationOnce((buffer) => read(buffer, 0, 1, 0));
  });
  expect((await codexRepositoryTrustRoot(checkout))?.path).toBe(repo);
});

test("C-CODEX-15 metadata that grows after fstat withholds the root", async () => {
  const { checkout, marker } = createLinkedCheckout(root);
  fs.writeFileSync(marker, fs.readFileSync(marker, "utf8").replace(/\n$/, ""));
  await changeFirstRead((file) => {
    const read = file.read.bind(file);
    vi.spyOn(file, "read").mockImplementationOnce((buffer, offset, length, position) => {
      fs.appendFileSync(marker, "\n");
      return read(buffer, offset, length, position);
    });
  });
  await expect(codexRepositoryTrustRoot(checkout)).rejects.toThrow();
});
