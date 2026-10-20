/** Private Claude auth/config and runtime seams for native question proofs (PRD §12). */
import { spawnSync } from "node:child_process";
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
import { join } from "node:path";
import { nodePtyFactory } from "../../../src/pty/node.ts";
import { runProbe } from "../../../src/runtime/probe.ts";
import {
  resetRuntimeSeamsForTests,
  setCommandRunnerForTests,
  setPtyFactoryForTests,
} from "../../../src/runtime/seams.ts";
import { shellQuote } from "../../../src/runtime/shell.ts";
import { assertParentEnvironmentUnchanged } from "../codex-response-sandbox.ts";

function credentials(): string {
  const result = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error("Private Claude authentication unavailable");
  JSON.parse(result.stdout);
  return result.stdout.trim();
}

function parentFingerprint(): string {
  const paths = [".claude.json", ".claude/settings.json", ".claude/hooks.json"];
  return createHash("sha256")
    .update(credentials())
    .update(
      paths
        .map((name) => {
          const path = join(homedir(), name);
          return existsSync(path) ? readFileSync(path).toString("base64") : "absent";
        })
        .join(":"),
    )
    .digest("hex");
}

export async function nativeClaudeQuestionSandbox() {
  const environment = { ...process.env };
  const fingerprint = parentFingerprint();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "elwood_native_claude_questions-")));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const stateDir = join(root, "state");
  const bin = join(root, "bin");
  const writes: string[] = [];
  try {
    for (const dir of [home, cwd, stateDir, bin]) mkdirSync(dir, { mode: 0o700 });
    const binary = join(bin, "claude");
    copyFileSync(realpathSync(join(homedir(), ".local/bin/claude")), binary);
    chmodSync(binary, 0o700);
    writeFileSync(join(home, ".credentials.json"), credentials(), { mode: 0o600 });
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        hasCompletedOnboarding: true,
        lastOnboardingVersion: "2.1.305",
        theme: "dark",
        projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
      }),
      { mode: 0o600 },
    );
    const version = await runProbe(binary, ["--version"]);
    if (version.stdout.trim() !== "2.1.305 (Claude Code)")
      throw new Error("Pinned Claude question version unavailable");
    const pin = (args: readonly string[]) =>
      args.map((arg, index) =>
        index === args.length - 1
          ? `export CLAUDE_CONFIG_DIR=${shellQuote(home)} ZDOTDIR=${shellQuote(home)} PATH=${shellQuote(bin)}:"$PATH"; unset CLAUDECODE ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL; ${arg}`
          : arg,
      );
    setCommandRunnerForTests((command, args) =>
      runProbe("env", [`CLAUDE_CONFIG_DIR=${home}`, `ZDOTDIR=${home}`, command, ...pin(args)]),
    );
    setPtyFactoryForTests((options) => {
      const env: Record<string, string> = {
        ...options.env,
        CLAUDE_CONFIG_DIR: home,
        ZDOTDIR: home,
      };
      for (const key of Object.keys(env)) {
        if (
          key === "CLAUDECODE" ||
          key.startsWith("CLAUDE_CODE_") ||
          ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"].includes(key)
        )
          delete env[key];
      }
      const pty = nodePtyFactory({ ...options, args: pin(options.args), env });
      return {
        ...pty,
        write(data) {
          writes.push(typeof data === "string" ? data : Buffer.from(data).toString());
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
      dispose() {
        resetRuntimeSeamsForTests();
        rmSync(root, { recursive: true, force: true });
        assertParentEnvironmentUnchanged(environment, process.env);
        if (fingerprint !== parentFingerprint())
          throw new Error("Parent Claude configuration changed");
      },
    };
  } catch (error) {
    resetRuntimeSeamsForTests();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
