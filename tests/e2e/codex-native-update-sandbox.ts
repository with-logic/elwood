/** Isolate a real pinned Codex updater; allow terminal replies and reject all menu input. */
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
import { nodePtyFactory } from "../../src/pty/node.ts";
import { runProbe } from "../../src/runtime/probe.ts";
import { setCommandRunnerForTests, setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { shellQuote } from "../../src/runtime/shell.ts";

export async function nativeUpdaterSandbox(sourceBinary: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "elwood_native_update-")));
  const project = join(root, "project");
  const home = join(root, "codex-home");
  const release = join(home, "packages/standalone/releases/0.155.1-aarch64-apple-darwin");
  const previousHome = process.env["CODEX_HOME"];
  const dispose = () => {
    if (previousHome === undefined) delete process.env["CODEX_HOME"];
    else process.env["CODEX_HOME"] = previousHome;
    rmSync(root, { recursive: true, force: true });
  };
  try {
    mkdirSync(project);
    mkdirSync(release, { recursive: true, mode: 0o700 });
    const binary = join(release, "codex");
    copyFileSync(sourceBinary, binary);
    chmodSync(binary, 0o700);
    copyFileSync(join(homedir(), ".codex/auth.json"), join(home, "auth.json"));
    chmodSync(join(home, "auth.json"), 0o600);
    writeFileSync(
      join(home, "config.toml"),
      `check_for_update_on_startup = true\n[projects."${project}"]\ntrust_level = "trusted"\n`,
    );
    writeFileSync(
      join(home, "version.json"),
      JSON.stringify({
        latest_version: "0.156.1",
        last_checked_at: new Date().toISOString(),
        dismissed_version: null,
      }),
    );
    process.env["CODEX_HOME"] = home;
    const version = await runProbe(binary, ["--version"]);
    if (version.status !== 0 || !/^codex-cli 0\.155\.1\s*$/.test(version.stdout))
      throw new Error("Native updater proof requires Codex 0.155.1");
    // Check authentication without recording login output or any credential material.
    if ((await runProbe(binary, ["login", "status"])).status !== 0)
      throw new Error("Native updater proof requires authenticated Codex");
    const pin = (args: readonly string[]) =>
      args.map((arg, index) =>
        index === args.length - 1 ? `export PATH=${shellQuote(release)}:"$PATH"; ${arg}` : arg,
      );
    setCommandRunnerForTests((command, args) => runProbe(command, pin(args)));
    const applicationAttempts: string[] = [];
    const protocolReplies: string[] = [];
    setPtyFactoryForTests((options) => {
      const pty = nodePtyFactory({ ...options, args: pin(options.args) });
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
            throw new Error("Unexpected application input during native updater proof");
          }
        },
      };
    });
    return {
      project,
      version: version.stdout.trim(),
      applicationAttempts,
      protocolReplies,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
