/**
 * Process and PTY drivers for the compiled-CLI command e2e (sessions, resume, models,
 * interactive). Implements PRD §12A.7-§12A.10 and C-CLI-23 through C-CLI-26.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { spawn as spawnPty } from "node-pty";
import { e2eTimeoutMs } from "./helpers.ts";

export type Invocation = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

export type PtyRun = {
  readonly exitCode: number;
  readonly sawComposer: boolean;
  readonly output: string;
};

export const entryPath = fileURLToPath(new URL("../../dist/cli/entry.js", import.meta.url));

export function parse<T>(result: Invocation, expectedStatus = 0): T {
  if (result.status !== expectedStatus) throw new Error(result.stderr);
  if (result.stdout.includes("\u001b"))
    throw new Error("Structured stdout contains terminal escapes.");
  return JSON.parse(result.stdout) as T;
}

export async function invoke(args: readonly string[], cwd: string): Promise<Invocation> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entryPath, ...args], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGINT");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, e2eTimeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (status) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) reject(new Error(`CLI timed out: ${stderr}`));
      else resolve({ status, stdout, stderr });
    });
    child.stdin.end();
  });
}

/**
 * Run interactive mode in a real PTY, wait for the agent's composer, and quit through
 * the agent. Interactive mode leaves the agent's own dialogs to the user, so the driver
 * answers Codex's update prompt with Skip and either agent's directory-trust prompt with
 * Yes before the composer can appear (docs/cli-behavior.md).
 */
export function drivePty(
  agent: "claude" | "codex",
  stateDir: string,
  cwd: string,
): Promise<PtyRun> {
  return new Promise((resolve) => {
    const pty = spawnPty(
      process.execPath,
      [entryPath, "interactive", `--agent=${agent}`, `--state-dir=${stateDir}`, "-C", cwd],
      {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd,
        env: process.env as Record<string, string>,
      },
    );
    let output = "";
    let recent = "";
    let sawComposer = false;
    let answered = 0;
    const started = Date.now();
    pty.onData((data) => {
      output += data;
      recent = (recent + data).slice(-60_000); // per-glyph SGR runs make frames long
      // The TUIs place words with CSI cursor moves, so strip control sequences and
      // match words with `\s*` between them. Claude's folder gate is a cursor list
      // starting on "No, exit": Down then Enter selects "Yes, I trust this folder";
      // Codex's dialogs are numbered.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: CSI is a control-byte protocol.
      const withoutCsi = recent.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
      // Codex interleaves OSC title updates mid-frame, splitting visible words.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: OSC is a control-byte protocol.
      const plain = withoutCsi.replace(/\u001b\][^\u0007]*\u0007/g, "");
      const dialog = /Update\s*now/.test(plain)
        ? "2\r"
        : /trust\s*the\s*contents\s*of\s*this\s*directory/i.test(plain)
          ? "1\r"
          : /project\s*you\s*created\s*or\s*one\s*you\s*trust|Do\s*you\s*trust\s*this\s*folder/i.test(
                plain,
              )
            ? "\u001b[B\r"
            : undefined;
      if (dialog !== undefined && answered < 4) {
        answered += 1;
        recent = "";
        setTimeout(() => pty.write(dialog), 1_000);
        return;
      }
      const composer =
        agent === "claude" ? /❯/.test(plain) : /Ask\s*Codex\s*to\s*do\s*anything/.test(plain);
      if (composer && !sawComposer && Date.now() - started > 4_000) {
        sawComposer = true;
        // Claude exits on `/exit`; a typed `/quit` did not end Codex 0.153.4, but its
        // idle double Ctrl-C does (status 0), exactly as at a real keyboard.
        if (agent === "claude") setTimeout(() => pty.write("/exit\r"), 1_500);
        else {
          setTimeout(() => pty.write("\u0003"), 1_500);
          setTimeout(() => pty.write("\u0003"), 2_300);
        }
      }
    });
    const guard = setTimeout(() => pty.kill(), e2eTimeoutMs);
    pty.onExit(({ exitCode }) => {
      clearTimeout(guard);
      resolve({ exitCode, sawComposer, output });
    });
  });
}
