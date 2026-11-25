/** Check Claude's native workspace disclosure against Git scope and live xterm cells (C-ATTN-07). */
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { matchClaudeWorkspaceTrustMenu } from "../../src/claude/workspace-trust/menu.ts";
import { settledLiveSnapshot } from "../../src/terminal/cursor.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";
import { tty } from "../fixtures/trust-composer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { tempDir } from "../helpers/tmp.ts";

const capture = capturedFrame("claude-2.1.310/folder-trust-no").trimEnd();
const width = 189;
const disclosedPath = "/tmp/ELWOOD_CAPTURE/project";

function launchScope(cwd: string, targetPath = cwd) {
  const terminal = createHeadlessTerminal({ cols: width, rows: 32 }, () => undefined);
  const match = matchClaudeWorkspaceTrustMenu({
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
  return { terminal, read, render, menu: capture.replace(disclosedPath, cwd) };
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
