/** Private Claude auth/config and runtime seams for native question proofs (PRD §12). */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { nodePtyFactory } from "../../../src/pty/node.ts";
import { runProbe } from "../../../src/runtime/probe/index.ts";
import {
  resetRuntimeSeamsForTests,
  setCommandRunnerForTests,
  setPtyFactoryForTests,
} from "../../../src/runtime/seams.ts";
import { shellQuote } from "../../../src/runtime/shell.ts";
import { privateTempDir } from "../../helpers/private-temp.ts";
import { accessOnlyLogin, anthropicCredentialVariables, keychainLogin } from "../claude-login.ts";
import { isNestedClaudeVariable } from "../claude-temp.ts";
import { registerPrivateHome } from "../home-guard.ts";
import { assertParentEnvironmentUnchanged } from "../parent-environment.ts";
import { prefixShellArgument } from "../prefix-shell-argument.ts";
import { claudeQuestionLabel, claudeQuestionVersion } from "./claude-cases.ts";
import {
  assertParentUnchanged,
  parentConfiguration,
  parentFingerprint,
  userConfigDirSetting,
} from "./claude-parent.ts";

/** The Anthropic variables a pinned question Claude never sees: its login, and its endpoint. */
const anthropicVariables = [...anthropicCredentialVariables, "ANTHROPIC_BASE_URL"];

/** The skip gate and sandbox select from the same pinned and installed binary locations. */
export function claudeQuestionBinary(): string | undefined {
  return [
    join(homedir(), ".local/share/claude/versions", claudeQuestionVersion),
    join(homedir(), ".local/bin/claude"),
  ].find((path) => existsSync(path));
}

/** The keychain login JSON, the same item the default e2e config dir copies (`claude-login.ts`). */
function credentials(): string {
  const login = keychainLogin();
  if (login === undefined) throw new Error("Private Claude authentication unavailable");
  return login.trim();
}

/** Owns private credentials and process seams; dispose removes/resets them and checks parent drift:
 * the parent settings, hooks, and login are unchanged, and its global config names no private path.
 * Only the default Claude config dir is supported: a set `CLAUDE_CONFIG_DIR` fails setup.
 * Setup failures attempt private-root cleanup and preserve the original error; disposal may report drift.
 */
export async function nativeClaudeQuestionSandbox() {
  // The parent files and keychain item `claude-parent.ts` checks are the default config dir's.
  if (userConfigDirSetting())
    throw new Error("The native Claude question proof needs the default Claude config dir");
  const environment = { ...process.env };
  const credential = credentials();
  // Reduced before any private file exists, so a keychain item without a login leaves nothing.
  const login = accessOnlyLogin(credential, "Private Claude authentication");
  if (login === undefined) throw new Error("Private Claude authentication holds no Claude login");
  const fingerprint = parentFingerprint(credential);
  parentConfiguration(); // refuse a parent config the post-run check cannot read
  const root = realpathSync(
    privateTempDir(
      "elwood_native_claude_questions-",
      join(homedir(), ".claude"),
      "Claude config dir",
    ),
  );
  const home = join(root, "home");
  const cwd = join(root, "project");
  const stateDir = join(root, "state");
  const bin = join(root, "bin");
  const writes: string[] = [];
  let unregisterHome = () => {};
  try {
    for (const dir of [home, cwd, stateDir, bin]) mkdirSync(dir, { mode: 0o700 });
    unregisterHome = registerPrivateHome(home);
    const binary = join(bin, "claude");
    const installed = claudeQuestionBinary();
    if (!installed) throw new Error(`${claudeQuestionLabel} binary unavailable`);
    copyFileSync(realpathSync(installed), binary);
    chmodSync(binary, 0o700);
    writeFileSync(join(home, ".credentials.json"), login, { mode: 0o600 });
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
        `export HOME=${shellQuote(home)} CLAUDE_CONFIG_DIR=${shellQuote(home)} ZDOTDIR=${shellQuote(home)} PATH=${shellQuote(bin)}:"$PATH"; unset CLAUDECODE ${anthropicVariables.join(" ")}`,
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
      // Claude's temp root stays: `claude-home.ts` set it to a private directory.
      for (const key of Object.keys(env)) {
        if (isNestedClaudeVariable(key) || anthropicVariables.includes(key)) delete env[key];
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
        unregisterHome();
        resetRuntimeSeamsForTests();
        rmSync(root, { recursive: true, force: true });
        assertParentEnvironmentUnchanged(environment, process.env);
        assertParentUnchanged(fingerprint, credentials(), root);
      },
    };
  } catch (error) {
    unregisterHome();
    resetRuntimeSeamsForTests();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Keep the setup failure as the primary diagnostic if private-file removal also fails.
    }
    throw error;
  }
}
