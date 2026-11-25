/** Reject replaceable Git metadata in Claude trust target evidence (PRD §5.1). */
import {
  chmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { resolveClaudeWorkspaceTrustTarget } from "../../src/claude/workspace-trust/target.ts";
import { tempDir } from "../helpers/tmp.ts";

vi.mock("node:fs", { spy: true });

test("a foreign-owned Git marker cannot set Claude's scope across an ancestor", async () => {
  const root = realpathSync(tempDir());
  const checkout = join(root, "child");
  const git = join(root, ".git");
  mkdirSync(checkout);
  mkdirSync(git);
  writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
  expect(resolveClaudeWorkspaceTrustTarget(checkout)?.targetPath).toBe(root);

  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const foreignUid = actual.lstatSync(git).uid + 1;
  const mock = vi.mocked(lstatSync).mockImplementation((path, options) => {
    const info = actual.lstatSync(path, options);
    if (path === git && info) Object.assign(info, { uid: foreignUid });
    return info;
  });
  try {
    expect(resolveClaudeWorkspaceTrustTarget(checkout)).toBeUndefined();
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
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const { ino, uid } = actual.lstatSync(head);
  const mock = vi.mocked(fstatSync).mockImplementation((fd, options) => {
    const info = actual.fstatSync(fd, options);
    if (info.ino === ino) Object.assign(info, { uid: uid + 1 });
    return info;
  });
  try {
    expect(resolveClaudeWorkspaceTrustTarget(checkout)).toBeUndefined();
  } finally {
    mock.mockRestore();
  }
});

test("a replaceable ancestor cannot provide Claude's repository target", () => {
  const root = realpathSync(tempDir());
  const checkout = join(root, "child");
  const git = join(root, ".git");
  mkdirSync(checkout);
  mkdirSync(git);
  writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
  chmodSync(root, 0o777);
  expect(resolveClaudeWorkspaceTrustTarget(checkout)).toBeUndefined();
});

test("a writable gitfile cannot select metadata for Claude's repository target", () => {
  const root = realpathSync(tempDir());
  const metadata = join(root, "metadata");
  const checkout = join(root, "checkout");
  mkdirSync(metadata);
  mkdirSync(checkout);
  writeFileSync(join(metadata, "HEAD"), "ref: refs/heads/main\n");
  const git = join(checkout, ".git");
  writeFileSync(git, `gitdir: ${metadata}\n`);
  expect(resolveClaudeWorkspaceTrustTarget(checkout)?.targetPath).toBe(checkout);
  chmodSync(git, 0o1666);
  expect(resolveClaudeWorkspaceTrustTarget(checkout)).toBeUndefined();
});

test("a pointer cannot traverse a replaceable or symbolic component before dot-dot", () => {
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
  expect(resolveClaudeWorkspaceTrustTarget(checkout)?.targetPath).toBe(checkout);
  chmodSync(intermediate, 0o777);
  expect(resolveClaudeWorkspaceTrustTarget(checkout)).toBeUndefined();

  const symbolic = join(root, "symbolic");
  symlinkSync(intermediate, symbolic);
  writeFileSync(git, `gitdir: ${symbolic}/../metadata\n`);
  expect(resolveClaudeWorkspaceTrustTarget(checkout)).toBeUndefined();
});

test.each(["getuid", "getgid"])("repository evidence requires POSIX %s", (name) => {
  const root = realpathSync(tempDir());
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  vi.stubGlobal("process", Object.create(process, { [name]: { value: undefined } }));
  try {
    expect(resolveClaudeWorkspaceTrustTarget(root)).toBeUndefined();
  } finally {
    vi.unstubAllGlobals();
  }
});

test("the Git evidence cannot traverse a replaceable filesystem root", async () => {
  const root = realpathSync(tempDir());
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const mock = vi.mocked(lstatSync).mockImplementation((path, options) => {
    const info = actual.lstatSync(path, options);
    if (path === "/" && info) Object.assign(info, { mode: 0o40777 });
    return info;
  });
  try {
    expect(resolveClaudeWorkspaceTrustTarget(root)).toBeUndefined();
  } finally {
    mock.mockRestore();
  }
});
