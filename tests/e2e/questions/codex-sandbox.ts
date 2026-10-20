/** Private current-Codex PTY and parent-state checks for native questions (PRD §12). */
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { nodePtyFactory } from "../../../src/pty/node.ts";
import { runProbe } from "../../../src/runtime/probe.ts";
import { attachPtyTerminal } from "../../../src/terminal/headless.ts";
import { assertParentEnvironmentUnchanged } from "../codex-response-sandbox.ts";

export const questionCodexBinary = join(homedir(), ".local/bin/codex");
export const questionCodexVersion = "codex-cli 0.163.0";
export const questionCodexModel = "gpt-6-luna";

function parentConfiguration(): string {
  return ["auth.json", "config.toml", "hooks.json"]
    .map((name) => {
      const path = join(homedir(), ".codex", name);
      return existsSync(path)
        ? createHash("sha256").update(readFileSync(path)).digest("hex")
        : "absent";
    })
    .join(":");
}

export async function nativeCodexQuestionSandbox() {
  const environment = { ...process.env };
  const configuration = parentConfiguration();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "elwood_native_questions-")));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const binary = join(root, "bin", "codex");
  try {
    for (const dir of [home, cwd, join(root, "bin")]) mkdirSync(dir, { mode: 0o700 });
    const installed = realpathSync(questionCodexBinary);
    copyFileSync(installed, binary);
    chmodSync(binary, 0o700);
    const host = join(root, "bin", "codex-code-mode-host");
    copyFileSync(join(dirname(installed), "codex-code-mode-host"), host);
    chmodSync(host, 0o700);
    copyFileSync(join(homedir(), ".codex/auth.json"), join(home, "auth.json"));
    chmodSync(join(home, "auth.json"), 0o600);
    writeFileSync(
      join(home, "config.toml"),
      `check_for_update_on_startup = false\n[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n[tui]\nstatus_line = ["model-with-reasoning"]\n`,
      { mode: 0o600 },
    );
    const version = await runProbe(binary, ["--version"]);
    if (version.stdout.trim() !== questionCodexVersion)
      throw new Error("Pinned Codex question version unavailable");
    const pty = nodePtyFactory({
      command: binary,
      args: [
        "--model",
        questionCodexModel,
        "-c",
        'model_reasoning_effort="low"',
        "--sandbox",
        "read-only",
        "--ask-for-approval",
        "never",
        "--no-alt-screen",
      ],
      cwd,
      env: { ...environment, CODEX_HOME: home, ZDOTDIR: home },
      size: { cols: 140, rows: 45 },
    });
    let exited = false;
    const exit = new Promise<void>((resolve) => {
      pty.onExit(() => {
        exited = true;
        resolve();
      });
    });
    const terminal = attachPtyTerminal({ cols: 140, rows: 45 }, pty, () => {});
    return {
      root,
      home,
      cwd,
      pty,
      terminal,
      async dispose() {
        try {
          if (!exited) {
            pty.kill("SIGTERM");
            const deadline = setTimeout(() => pty.kill("SIGKILL"), 2_000);
            await exit.finally(() => clearTimeout(deadline));
          }
        } finally {
          terminal.dispose();
          rmSync(root, { recursive: true, force: true });
        }
        if (existsSync(root)) throw new Error("Private Codex question sandbox remains");
        assertParentEnvironmentUnchanged(environment, process.env);
        if (configuration !== parentConfiguration())
          throw new Error("Parent Codex configuration changed");
      },
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
