/** Reject replaceable Git metadata in Claude trust target evidence (PRD §5.1). */
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { assert, expect, test, vi } from "vitest";
import {
  captureClaudeWorkspaceTrustTarget,
  resolveClaudeWorkspaceTrustTarget,
} from "../../src/claude/workspace-trust/target.ts";
import { tempDir } from "../helpers/tmp.ts";

vi.mock("node:fs/promises", { spy: true });

test("a foreign-owned Git marker cannot set Claude's scope across an ancestor", async () => {
  const root = realpathSync(tempDir());
  const checkout = join(root, "child");
  const git = join(root, ".git");
  mkdirSync(checkout);
  mkdirSync(git);
  writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
  expect((await resolveClaudeWorkspaceTrustTarget(checkout))?.targetPath).toBe(root);

  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const foreignUid = lstatSync(git).uid + 1;
  const mock = vi.mocked(lstat).mockImplementation(async (...args) => {
    const info = await Reflect.apply(actual.lstat, undefined, args);
    if (args[0] === git && info) Object.assign(info, { uid: foreignUid });
    return info;
  });
  try {
    expect(await resolveClaudeWorkspaceTrustTarget(checkout)).toBeUndefined();
  } finally {
    mock.mockRestore();
  }
});

test("a foreign-owned HEAD cannot set Claude's scope", async () => {
  const checkout = realpathSync(tempDir());
  const git = join(checkout, ".git");
  mkdirSync(git);
  const head = join(git, "HEAD");
  writeFileSync(head, "ref: refs/heads/main\n");
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const { ino, uid } = lstatSync(head);
  const mock = vi.mocked(open).mockImplementation(async (...options) => {
    const handle = await actual.open(...options);
    if (options[0] === head) {
      const inspect = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementation(async (options) => {
        const info = await inspect(options);
        if (info.ino === ino) Object.assign(info, { uid: uid + 1 });
        return info;
      });
    }
    return handle;
  });
  try {
    expect(await resolveClaudeWorkspaceTrustTarget(checkout)).toBeUndefined();
  } finally {
    mock.mockRestore();
  }
});

test("a replaceable ancestor cannot provide Claude's repository target", async () => {
  const root = realpathSync(tempDir());
  const checkout = join(root, "child");
  const git = join(root, ".git");
  mkdirSync(checkout);
  mkdirSync(git);
  writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
  chmodSync(root, 0o777);
  expect(await resolveClaudeWorkspaceTrustTarget(checkout)).toBeUndefined();
});

test("a writable gitfile cannot select metadata for Claude's repository target", async () => {
  const root = realpathSync(tempDir());
  const metadata = join(root, "metadata");
  const checkout = join(root, "checkout");
  mkdirSync(metadata);
  mkdirSync(checkout);
  writeFileSync(join(metadata, "HEAD"), "ref: refs/heads/main\n");
  const git = join(checkout, ".git");
  writeFileSync(git, `gitdir: ${metadata}\n`);
  expect((await resolveClaudeWorkspaceTrustTarget(checkout))?.targetPath).toBe(checkout);
  chmodSync(git, 0o1666);
  expect(await resolveClaudeWorkspaceTrustTarget(checkout)).toBeUndefined();
});

test("a pointer cannot traverse a replaceable or symbolic component before dot-dot", async () => {
  const root = realpathSync(tempDir());
  const metadata = join(root, "metadata");
  const checkout = join(root, "checkout");
  const intermediate = join(root, "intermediate");
  mkdirSync(metadata);
  mkdirSync(checkout);
  mkdirSync(intermediate);
  writeFileSync(join(metadata, "HEAD"), "ref: refs/heads/main\n");
  const git = join(checkout, ".git");
  writeFileSync(git, `gitdir: ${intermediate}/../metadata\n`);
  expect((await resolveClaudeWorkspaceTrustTarget(checkout))?.targetPath).toBe(checkout);
  chmodSync(intermediate, 0o777);
  expect(await resolveClaudeWorkspaceTrustTarget(checkout)).toBeUndefined();

  const symbolic = join(root, "symbolic");
  symlinkSync(intermediate, symbolic);
  writeFileSync(git, `gitdir: ${symbolic}/../metadata\n`);
  expect(await resolveClaudeWorkspaceTrustTarget(checkout)).toBeUndefined();
});

test.each(["getuid", "getgid"])("repository evidence requires POSIX %s", async (name) => {
  const root = realpathSync(tempDir());
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  vi.stubGlobal("process", Object.create(process, { [name]: { value: undefined } }));
  try {
    expect(await resolveClaudeWorkspaceTrustTarget(root)).toBeUndefined();
  } finally {
    vi.unstubAllGlobals();
  }
});

test("the Git evidence cannot traverse a replaceable filesystem root", async () => {
  const root = realpathSync(tempDir());
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const mock = vi.mocked(lstat).mockImplementation(async (...args) => {
    const info = await Reflect.apply(actual.lstat, undefined, args);
    if (args[0] === "/" && info) Object.assign(info, { mode: 0o40777 });
    return info;
  });
  try {
    expect(await resolveClaudeWorkspaceTrustTarget(root)).toBeUndefined();
  } finally {
    mock.mockRestore();
  }
});

test("replacing a linked worktree's main checkout permanently revokes its captured target", async () => {
  const parent = realpathSync(tempDir());
  const root = join(parent, "main");
  const worktree = join(parent, "linked");
  const common = join(root, ".git");
  const administrative = join(common, "worktrees", "linked");
  mkdirSync(administrative, { recursive: true });
  mkdirSync(worktree);
  writeFileSync(join(common, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(administrative, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(administrative, "commondir"), "../..\n");
  writeFileSync(join(administrative, "gitdir"), join(worktree, ".git"));
  writeFileSync(join(worktree, ".git"), `gitdir: ${administrative}\n`);
  const target = { physicalLaunchPath: worktree, targetPath: root, targetScope: "repository" };
  const captured = await captureClaudeWorkspaceTrustTarget({
    agent: "claude",
    cwd: worktree,
    identity: statSync(worktree, { bigint: true }),
  });
  assert.isDefined(captured);
  expect(captured.scope).toEqual(target);

  const former = join(parent, "former-main");
  renameSync(root, former);
  mkdirSync(root);
  renameSync(join(former, ".git"), common);
  expect(await resolveClaudeWorkspaceTrustTarget(worktree)).toEqual(target);
  expect(await captured.isCurrent()).toBe(false);

  renameSync(common, join(former, ".git"));
  renameSync(root, join(parent, "replacement"));
  renameSync(former, root);
  expect(await resolveClaudeWorkspaceTrustTarget(worktree)).toEqual(target);
  expect(await captured.isCurrent()).toBe(false);
});
