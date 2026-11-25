/** Check Claude's native workspace disclosure against Git scope and live xterm cells (C-ATTN-07). */
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createClaudeWorkspaceTrustMenuMatcher } from "../../src/claude/workspace-trust/menu.ts";
import { settledLiveSnapshot } from "../../src/terminal/cursor.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";
import { tty } from "../fixtures/trust-composer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { claudeWorkspaceTrustScreen } from "../helpers/claude-workspace-trust-screen.ts";
import { tempDir } from "../helpers/tmp.ts";

const width = 189;

function launchScope(cwd: string, targetPath = cwd, cols = width) {
  const terminal = createHeadlessTerminal({ cols, rows: 32 }, () => undefined);
  const match = createClaudeWorkspaceTrustMenuMatcher({
    physicalLaunchPath: cwd,
    targetPath,
    targetScope: targetPath === cwd ? "folder" : "repository",
  });
  const read = () => {
    const frame = settledLiveSnapshot(terminal);
    if (!frame) throw new Error("Expected a settled xterm frame.");
    const menu = match(terminal, frame);
    return menu && { ...menu.target, choices: menu.dialog.options };
  };
  const render = (screen: string) => terminal.writeOutput(`\x1b[2J\x1b[H${tty(screen)}`);
  return { terminal, read, render, menu: claudeWorkspaceTrustScreen(cwd) };
}

test("C-ATTN-07 Claude disclosure shows the verified scope and native choices", async () => {
  const repo = realpathSync(tempDir());
  const cwd = join(repo, "nested");
  mkdirSync(cwd);
  const { terminal, read, render, menu } = launchScope(cwd, repo);
  try {
    await render(menu);
    expect(read()).toMatchObject({
      targetPath: repo,
      targetScope: "repository",
      choices: [{ label: "No, exit" }, { label: "Yes, I trust this folder" }],
    });
  } finally {
    terminal.dispose();
  }
});

test.each([
  ["a startup status line", () => "starting"],
  ["another known gate", () => capturedFrame("claude-2.1.310/bypass-permissions-200")],
  ["missing prelude", (menu: string) => menu.replace("Accessing workspace:", "")],
  ["missing path", (menu: string, cwd: string) => menu.replace(cwd, "")],
  ["wrong path", (menu: string, cwd: string) => menu.replace(cwd, `${cwd}-other`)],
  ["extra path row", (menu: string, cwd: string) => menu.replace(cwd, `${cwd}\nother`)],
  ["clipped path", (menu: string, cwd: string) => menu.replace(` ${cwd}`, cwd.padStart(width))],
  ["missing footer", (menu: string) => menu.replace("Enter to confirm · Esc to cancel", "")],
  ["missing choice", (menu: string) => menu.replace("   Yes, I trust this folder\n", "")],
  ["bare decline", (menu: string) => menu.replace("No, exit", "No")],
  ["unknown decline", (menu: string) => menu.replace("No, exit", "No, cancel")],
  ["bare affirmative", (menu: string) => menu.replace("Yes, I trust this folder", "Yes")],
])("C-ATTN-07 Claude does not disclose workspace trust with %s", async (_reason, change) => {
  const cwd = realpathSync(tempDir());
  const { terminal, read, render, menu } = launchScope(cwd);
  try {
    await render(change(menu, cwd));
    expect(read()).toBeUndefined();
  } finally {
    terminal.dispose();
  }
});

test("C-ATTN-07 preserves native Claude numbered choice order", async () => {
  const cwd = realpathSync(tempDir());
  const { terminal, read, render, menu } = launchScope(cwd);
  try {
    await render(
      menu.replace(
        "❯ No, exit\n   Yes, I trust this folder",
        "❯ 1. Yes, I trust this folder\n   2. No, exit",
      ),
    );
    expect(read()?.choices.map(({ label }) => label)).toEqual([
      "Yes, I trust this folder",
      "No, exit",
    ]);
  } finally {
    terminal.dispose();
  }
});

test.each([
  "❯ 9. No, exit\n   9. Yes, I trust this folder",
  "❯ 1. No, exit\n   1. Yes, I trust this folder",
  "   1. No, exit\n   2. Yes, I trust this folder",
  "❯ 1. No, exit\n ❯ 2. Yes, I trust this folder",
  "❯ No, exit\n 2. Yes, I trust this folder",
  "❯ 1. No, exit\n ❯ Yes, I trust this folder",
])("C-ATTN-07 rejects a malformed Claude numbered choice layout %s", async (options) => {
  const cwd = realpathSync(tempDir());
  const { terminal, read, render, menu } = launchScope(cwd);
  try {
    await render(menu.replace("❯ No, exit\n   Yes, I trust this folder", options));
    expect(read()).toBeUndefined();
  } finally {
    terminal.dispose();
  }
});

const narrowedWidth = 100;
const pathRowWithNativeInset = (fragment: string) => `\x1b[2G${fragment}`;
const wrappedPath = `/${"a".repeat(97)}z`;

test.each([
  ["ASCII", wrappedPath.slice(0, 98)],
  ["wide boundary cell", `/${"a".repeat(95)}界`],
])("C-ATTN-07 Claude lists a cell-verified renderer-wrapped path with %s", async (_kind, prefix) => {
  const cwd = `${prefix}z`;
  const { terminal, read, render, menu } = launchScope(cwd, cwd, narrowedWidth);
  try {
    const rows = [pathRowWithNativeInset(prefix), pathRowWithNativeInset("z")];
    await render(menu.replace(` ${cwd}`, rows.join("\n")));
    expect(read()).toMatchObject({ targetPath: cwd, targetScope: "folder" });
  } finally {
    terminal.dispose();
  }
});

test.each([
  [
    "an early line break",
    (path: string) => [
      pathRowWithNativeInset(path.slice(0, 97)),
      pathRowWithNativeInset(path.slice(97)),
    ],
  ],
  [
    "a substituted continuation",
    (path: string) => [pathRowWithNativeInset(path.slice(0, 98)), pathRowWithNativeInset("y")],
  ],
  [
    "a full right margin",
    (path: string) => [
      pathRowWithNativeInset(`${path.slice(0, 98)} `),
      pathRowWithNativeInset(path.slice(98)),
    ],
  ],
  [
    "a wide character occupying the right margin",
    (path: string) => [pathRowWithNativeInset(path.slice(0, -1)), pathRowWithNativeInset("z")],
    `/${"a".repeat(96)}界z`,
  ],
  [
    "a literal indent",
    (path: string) => [` ${path.slice(0, 98)}`, pathRowWithNativeInset(path.slice(98))],
  ],
  [
    "a blank intervening row",
    (path: string) => [
      pathRowWithNativeInset(path.slice(0, 98)),
      "",
      pathRowWithNativeInset(path.slice(98)),
    ],
  ],
])("C-ATTN-07 rejects a wrapped Claude disclosure with %s", async (_reason, pathRows, cwd = wrappedPath) => {
  const { terminal, read, render, menu } = launchScope(cwd, cwd, narrowedWidth);
  try {
    await render(menu.replace(` ${cwd}`, pathRows(cwd).join("\n")));
    expect(read()).toBeUndefined();
  } finally {
    terminal.dispose();
  }
});
