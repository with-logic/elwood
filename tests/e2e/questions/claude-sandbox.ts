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
import { basename, join } from "node:path";
import { nodePtyFactory } from "../../../src/pty/node.ts";
import { runProbe } from "../../../src/runtime/probe/index.ts";
import {
  resetRuntimeSeamsForTests,
  setCommandRunnerForTests,
  setPtyFactoryForTests,
} from "../../../src/runtime/seams.ts";
import { shellQuote } from "../../../src/runtime/shell.ts";
import { assertParentEnvironmentUnchanged } from "../parent-environment.ts";
import { parentFileFingerprint } from "../parent-file-fingerprint.ts";
import { prefixShellArgument } from "../prefix-shell-argument.ts";
import { claudeQuestionLabel, claudeQuestionVersion } from "./claude-cases.ts";

const keychainTimeoutMs = 5_000;

/** The skip gate and sandbox select from the same pinned and installed binary locations. */
export function claudeQuestionBinary(): string | undefined {
  return [
    join(homedir(), ".local/share/claude/versions", claudeQuestionVersion),
    join(homedir(), ".local/bin/claude"),
  ].find((path) => existsSync(path));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parentConfiguration(path: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new Error("Parent Claude configuration must be a JSON object");
  return parsed;
}

/** The `projects` keys of the parent global config at `path` that name the private `root`. */
function parentProjectsNaming(path: string, root: string): readonly string[] {
  const projects = parentConfiguration(path)["projects"];
  const name = basename(root);
  return isRecord(projects) ? Object.keys(projects).filter((key) => key.includes(name)) : [];
}

function credentials(): string {
  const result = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
    { encoding: "utf8", timeout: keychainTimeoutMs },
  );
  if (result.status !== 0) throw new Error("Private Claude authentication unavailable");
  try {
    JSON.parse(result.stdout);
  } catch {
    throw new Error("Private Claude authentication is malformed");
  }
  return result.stdout.trim();
}

/**
 * The parent's settings, hooks, and login. The global config is left out: Claude sessions
 * outside the proof rewrite it all the time, so `parentProjectsNaming` checks it instead.
 */
function parentFingerprint(credential: string): Readonly<Record<string, string>> {
  const paths = [".claude/settings.json", ".claude/hooks.json"];
  return Object.fromEntries([
    ["keychain", createHash("sha256").update(credential).digest("hex")],
    ...paths.map((name) => [name, parentFileFingerprint(join(homedir(), name))]),
  ]);
}

/** Owns private credentials and process seams; dispose removes/resets them and checks parent drift:
 * the parent settings, hooks, and login are unchanged, and its global config names no private path.
 * Setup failures attempt private-root cleanup and preserve the original error; disposal may report drift.
 */
export async function nativeClaudeQuestionSandbox() {
  const environment = { ...process.env };
  const credential = credentials();
  const fingerprint = parentFingerprint(credential);
  const globalPath = join(homedir(), ".claude.json");
  parentConfiguration(globalPath); // refuse a parent config the post-run check cannot read
  const root = realpathSync(mkdtempSync(join(tmpdir(), "elwood_native_claude_questions-")));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const stateDir = join(root, "state");
  const bin = join(root, "bin");
  const writes: string[] = [];
  try {
    for (const dir of [home, cwd, stateDir, bin]) mkdirSync(dir, { mode: 0o700 });
    const binary = join(bin, "claude");
    const installed = claudeQuestionBinary();
    if (!installed) throw new Error(`${claudeQuestionLabel} binary unavailable`);
    copyFileSync(realpathSync(installed), binary);
    chmodSync(binary, 0o700);
    writeFileSync(join(home, ".credentials.json"), credential, { mode: 0o600 });
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        hasCompletedOnboarding: true,
        lastOnboardingVersion: claudeQuestionVersion,
        theme: "dark",
        projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
      }),
      { mode: 0o600 },
    );
    const version = await runProbe("env", [
      `HOME=${home}`,
      `CLAUDE_CONFIG_DIR=${home}`,
      `ZDOTDIR=${home}`,
      binary,
      "--version",
    ]);
    if (version.status !== 0 || version.stdout.trim() !== `${claudeQuestionVersion} (Claude Code)`)
      throw new Error(`Pinned ${claudeQuestionLabel} question version unavailable`);
    const pin = (args: readonly string[]) =>
      prefixShellArgument(
        args,
        `export HOME=${shellQuote(home)} CLAUDE_CONFIG_DIR=${shellQuote(home)} ZDOTDIR=${shellQuote(home)} PATH=${shellQuote(bin)}:"$PATH"; unset CLAUDECODE ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL`,
      );
    setCommandRunnerForTests((command, args) =>
      runProbe("env", [
        `HOME=${home}`,
        `CLAUDE_CONFIG_DIR=${home}`,
        `ZDOTDIR=${home}`,
        command,
        ...pin(args),
      ]),
    );
    setPtyFactoryForTests((options) => {
      const env: Record<string, string> = {
        ...options.env,
        HOME: home,
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
        const after = parentFingerprint(credentials());
        const changed = Object.keys(fingerprint).filter(
          (name) => fingerprint[name] !== after[name],
        );
        if (changed.length)
          throw new Error(`Parent Claude configuration changed: ${changed.join(", ")}`);
        const named = parentProjectsNaming(globalPath, root);
        if (named.length)
          throw new Error(
            `Parent Claude global config names the private root: ${named.join(", ")}`,
          );
      },
    };
  } catch (error) {
    resetRuntimeSeamsForTests();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Keep the setup failure as the primary diagnostic if private-file removal also fails.
    }
    throw error;
  }
}
