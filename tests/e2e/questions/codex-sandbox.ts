/** Private current-Codex PTY and parent-state checks for native questions (PRD §12). */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { nodePtyFactory } from "../../../src/pty/node.ts";
import type { PtyExit } from "../../../src/pty/types.ts";
import { runProbe } from "../../../src/runtime/probe.ts";
import { attachPtyTerminal } from "../../../src/terminal/headless.ts";
import { parentCodexConfiguration } from "../codex-parent-state.ts";
import { assertParentEnvironmentUnchanged } from "../parent-environment.ts";

export const questionCodexBinary = join(homedir(), ".local/bin/codex");
export const questionCodexVersion = "codex-cli 0.163.0";
export const questionCodexModel = "gpt-6-luna";

/** Capture coordinates and the PTY viewport must describe the same native layout. */
const nativeQuestionSize = { cols: 140, rows: 45 } as const;
/** Let Codex flush its private home before escalating a stopped capture to SIGKILL. */
const shutdownGraceMs = 2_000;

export async function nativeCodexQuestionFiles() {
  const environment = { ...process.env };
  const configuration = parentCodexConfiguration();
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
    const version = await runProbe("env", [
      `CODEX_HOME=${home}`,
      `ZDOTDIR=${home}`,
      binary,
      "--version",
    ]);
    if (version.status !== 0 || version.error || version.stdout.trim() !== questionCodexVersion)
      throw new Error("Pinned Codex question version unavailable");
    return {
      root,
      home,
      cwd,
      binary,
      dispose() {
        rmSync(root, { recursive: true, force: true });
        if (existsSync(root)) throw new Error("Private Codex question sandbox remains");
        assertParentEnvironmentUnchanged(environment, process.env);
        if (configuration !== parentCodexConfiguration())
          throw new Error("Parent Codex configuration changed");
      },
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export async function nativeCodexQuestionSandbox() {
  const files = await nativeCodexQuestionFiles();
  const { binary, cwd, home } = files;
  try {
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
      env: { ...process.env, CODEX_HOME: home, ZDOTDIR: home },
      size: nativeQuestionSize,
    });
    let exitResult: PtyExit | undefined;
    const exit = new Promise<void>((resolve) => {
      pty.onExit((result) => {
        exitResult = result;
        resolve();
      });
    });
    const terminal = attachPtyTerminal(nativeQuestionSize, pty, () => {});
    return {
      ...files,
      pty,
      terminal,
      get exitResult() {
        return exitResult;
      },
      async dispose() {
        try {
          if (!exitResult) {
            pty.kill("SIGTERM");
            const deadline = setTimeout(() => pty.kill("SIGKILL"), shutdownGraceMs);
            await exit.finally(() => clearTimeout(deadline));
          }
        } finally {
          terminal.dispose();
          files.dispose();
        }
      },
    };
  } catch (error) {
    files.dispose();
    throw error;
  }
}
