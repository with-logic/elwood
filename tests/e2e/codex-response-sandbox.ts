/** Private pinned CLI and physical-input bounds for real response isolation (C-API-48). */
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexSessionOptions } from "../../src/index.ts";
import { nodePtyFactory } from "../../src/pty/node.ts";
import { runProbe } from "../../src/runtime/probe/index.ts";
import { setCommandRunnerForTests, setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { shellQuote } from "../../src/runtime/shell.ts";
import { copyCodexAuth } from "./codex-home.ts";
import { registerPrivateHome } from "./home-guard.ts";
import { prefixShellArgument } from "./prefix-shell-argument.ts";
import { stopProcessesUnder } from "./scratch-processes.ts";

export const responseModel = "gpt-6-luna";
export const responseBinary = join(
  homedir(),
  ".codex/packages/standalone/releases/0.159.2-aarch64-apple-darwin/bin/codex",
);

export async function nativeResponseSandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "elwood_native_response-")));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const stateDir = join(root, "state");
  const bin = join(root, "bin");
  const binary = join(bin, "codex");
  // Codex 0.159.2 may start an app-server daemon for `home`, which outlives the TUI.
  let unregisterHome = () => {};
  const dispose = () => {
    unregisterHome();
    stopProcessesUnder(root);
    rmSync(root, { recursive: true, force: true });
  };
  try {
    for (const dir of [home, cwd, stateDir, bin]) mkdirSync(dir, { mode: 0o700 });
    unregisterHome = registerPrivateHome(home);
    copyFileSync(responseBinary, binary);
    chmodSync(binary, 0o700);
    copyCodexAuth(home);
    writeFileSync(
      join(home, "config.toml"),
      `check_for_update_on_startup = false\n[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n[tui]\nstatus_line = ["model-with-reasoning"]\n`,
      { mode: 0o600 },
    );
    const version = await runProbe("env", [`CODEX_HOME=${home}`, binary, "--version"]);
    if (version.status !== 0 || version.stdout.trim() !== "codex-cli 0.159.2")
      throw new Error("Pinned Codex version unavailable");
    if ((await runProbe("env", [`CODEX_HOME=${home}`, binary, "login", "status"])).status !== 0)
      throw new Error("Private Codex authentication unavailable");
    const pin = (args: readonly string[]) =>
      prefixShellArgument(
        args,
        `export CODEX_HOME=${shellQuote(home)} PATH=${shellQuote(bin)}:"$PATH"`,
      );
    setCommandRunnerForTests((command, args) =>
      runProbe("env", [`ZDOTDIR=${home}`, command, ...pin(args)]),
    );
    let prompt: string | undefined;
    let resumed = false;
    const writes = { enters: 0, pastes: 0 };
    setPtyFactoryForTests((options) => {
      const command = options.args.at(-1);
      if (command === undefined || !command.startsWith("exec codex "))
        throw new Error("Unexpected native command");
      const pinned = resumed ? `${command} --model '${responseModel}'` : command;
      if (!pinned.includes(`--model '${responseModel}'`)) throw new Error("Missing pinned model");
      const pty = nodePtyFactory({
        ...options,
        args: pin([...options.args.slice(0, -1), pinned]),
        env: { ...options.env, CODEX_HOME: home, ZDOTDIR: home },
      });
      return {
        ...pty,
        write(data) {
          const input = typeof data === "string" ? data : Buffer.from(data).toString();
          if (!(input.startsWith("\x1b") && /^(?:\[\d+;\d+R|\[\?1;2c)$/.test(input.slice(1)))) {
            if (prompt === undefined)
              throw new Error("Unexpected startup/application input intercepted");
            if (input === "\r") {
              if (++writes.enters !== 1) throw new Error("Extra Enter intercepted");
            } else {
              if (++writes.pastes !== 1) throw new Error("Extra application input intercepted");
              if (input !== `\x1b[200~${prompt}\x1b[201~`)
                throw new Error("Unexpected paste intercepted");
            }
          }
          pty.write(data);
        },
      };
    });
    return {
      root,
      home,
      cwd,
      stateDir,
      writes,
      dispose,
      begin(nextPrompt: string) {
        prompt = nextPrompt;
        writes.enters = 0;
        writes.pastes = 0;
      },
      end() {
        prompt = undefined;
      },
      resume() {
        resumed = true;
      },
    };
  } catch (error) {
    try {
      dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Native response sandbox setup failed");
    }
    throw error;
  }
}

/** Shared pinned, no-tools session policy for both native response proofs. */
export function noToolsResponseOptions(
  sandbox: Pick<Awaited<ReturnType<typeof nativeResponseSandbox>>, "cwd" | "stateDir">,
  onToolAttempt: () => void,
): CodexSessionOptions {
  return {
    cwd: sandbox.cwd,
    stateDir: sandbox.stateDir,
    model: responseModel,
    reasoningEffort: "low",
    autotrust: true,
    autoupdate: false,
    sandbox: "read-only",
    approvalPolicy: "never",
    initialSize: { cols: 140, rows: 35 },
    hooks: {
      PreToolUse: () => {
        onToolAttempt();
        return {
          permissionDecision: "deny",
          permissionDecisionReason: "This response fixture permits no tools.",
        };
      },
    },
  };
}
