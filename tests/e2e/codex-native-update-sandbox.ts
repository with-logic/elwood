/** Isolate the native updater; record input and permit only a live-validated safe selection (PRD §5.5, C-CODEX-12). */
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodePtyFactory } from "../../src/pty/node.ts";
import { runProbe } from "../../src/runtime/probe/index.ts";
import {
  resetRuntimeSeamsForTests,
  setCommandRunnerForTests,
  setPtyFactoryForTests,
} from "../../src/runtime/seams.ts";
import { shellQuote } from "../../src/runtime/shell.ts";
import { prefixShellArgument } from "./prefix-shell-argument.ts";
import { type CodexSandbox, seedCodexHome } from "./scratch.ts";

export async function nativeUpdaterSandbox(sourceBinary: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "elwood_native_update-")));
  const project = join(root, "project");
  const codexProofHome = join(root, "codex-home");
  const release = join(codexProofHome, "packages/standalone/releases/0.155.1-aarch64-apple-darwin");
  const dispose = () => rmSync(root, { recursive: true, force: true });
  // A probe whose process group outlived its cleanup may still be running Codex in this home.
  let unconfirmedGroup: number | undefined;
  try {
    mkdirSync(project);
    mkdirSync(release, { recursive: true, mode: 0o700 });
    const binary = join(release, "codex");
    copyFileSync(sourceBinary, binary);
    chmodSync(binary, 0o700);
    const configPath = seedCodexHome(
      codexProofHome,
      `check_for_update_on_startup = true\n[projects."${project}"]\ntrust_level = "trusted"\n`,
    );
    writeFileSync(
      join(codexProofHome, "version.json"),
      JSON.stringify({
        latest_version: "0.156.1",
        last_checked_at: new Date().toISOString(),
        dismissed_version: null,
      }),
    );
    const probe = async (args: readonly string[]) => {
      const result = await runProbe("env", [`CODEX_HOME=${codexProofHome}`, binary, ...args]);
      unconfirmedGroup ??= result.error?.cleanupProcessGroupId;
      return result;
    };
    const version = await probe(["--version"]);
    if (version.status !== 0 || !/^codex-cli 0\.155\.1\s*$/.test(version.stdout))
      throw new Error("Native updater proof requires Codex 0.155.1");
    // Check authentication without recording login output or any credential material.
    if ((await probe(["login", "status"])).status !== 0)
      throw new Error("Native updater proof requires authenticated Codex");
    const pin = (args: readonly string[]) =>
      prefixShellArgument(
        args,
        `export CODEX_HOME=${shellQuote(codexProofHome)} PATH=${shellQuote(release)}:"$PATH"`,
      );
    setCommandRunnerForTests((command, args) => runProbe(command, pin(args)));
    const applicationAttempts: string[] = [];
    const protocolReplies: string[] = [];
    let permitSelection: (input: string) => boolean = () => false;
    setPtyFactoryForTests((options) => {
      const pty = nodePtyFactory({
        ...options,
        args: pin(options.args),
        env: { ...options.env, CODEX_HOME: codexProofHome },
      });
      return {
        ...pty,
        write(data) {
          const input = typeof data === "string" ? data : Buffer.from(data).toString();
          // Exact cursor-position and primary-device replies observed from the real TUI.
          if (input.startsWith("\x1b") && /^(?:\[\d+;\d+R|\[\?1;2c)$/.test(input.slice(1))) {
            protocolReplies.push(input);
            pty.write(data);
          } else {
            applicationAttempts.push(input);
            if (permitSelection(input)) {
              pty.write(data);
              return;
            }
            throw new Error("Unexpected application input during native updater proof");
          }
        },
      };
    });
    // The proof pins its home through the runtime seams rather than `CODEX_HOME`, so
    // unpinning them is what keeps a later test off this home, kept or removed.
    const codex: CodexSandbox = {
      project: {
        cwd: project,
        stateDir: join(project, ".state"),
        sessionDir: (id) => join(project, ".state", "sessions", id),
      },
      home: codexProofHome,
      configPath,
      dispose: () => {
        resetRuntimeSeamsForTests();
        dispose();
      },
      restoreHome: resetRuntimeSeamsForTests,
    };
    return {
      project,
      codex,
      version: version.stdout.trim(),
      applicationAttempts,
      protocolReplies,
      permitSafeSelection(check: (input: string) => boolean) {
        permitSelection = check;
      },
    };
  } catch (error) {
    if (unconfirmedGroup !== undefined) {
      const kept = `kept ${root}, which its Codex process group ${unconfirmedGroup} may still use`;
      throw new AggregateError([error], `Native updater preflight cleanup failed; ${kept}`);
    }
    dispose();
    throw error;
  }
}
