/**
 * The e2e CLI home guard (`homeGuardScript` in `src/runtime/shell.ts`, PRD §12, C-E2E-24).
 * The script cases check which homes are guarded. The shell cases run the guarded login shell
 * the way a session launches one, in a real PTY, in zsh and in bash, from a private `HOME`
 * whose startup file keeps or moves a guarded home: the command runs only when every guarded
 * home is still exported and its real path is one of the suite's registered homes. The homes
 * sit under a directory whose name holds a `:`, which a `:`-separated list would split.
 */

import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { nodePtyFactory } from "../../src/pty/node.ts";
import { homeGuardHomesKey, homeGuardStopLine } from "../../src/runtime/home-guard/index.ts";
import { homeGuardScript, loginShellCommand, shellQuote } from "../../src/runtime/shell.ts";
import { loginShells } from "../helpers/login-shells.ts";
import { tempDir } from "../helpers/tmp.ts";

afterEach(() => vi.unstubAllEnvs());

describe("C-E2E-24 the guarded homes", () => {
  test("no list adds nothing to the launch", () => {
    vi.stubEnv(homeGuardHomesKey, "");
    vi.stubEnv("CODEX_HOME", "/r/codex");
    expect(loginShellCommand("codex")).toEqual(["-l", "-i", "-c", "codex"]);
  });

  test("only a home Elwood's environment sets to a registered home is guarded", () => {
    vi.stubEnv(homeGuardHomesKey, JSON.stringify(["/r/codex", "/real/r/codex"]));
    vi.stubEnv("CODEX_HOME", "/real/r/codex");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/r/claude");
    const [, , , script] = loginShellCommand("codex");
    expect(script).toContain("printenv CODEX_HOME");
    expect(script).not.toContain("CLAUDE_CONFIG_DIR");
    expect(script).toContain("'/r/codex'|'/real/r/codex')");
    expect(script.endsWith("; codex")).toBe(true);
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined); // unset: nothing of it to guard
    expect(homeGuardScript()).not.toContain("CLAUDE_CONFIG_DIR");
  });

  test.each([
    ["not JSON", "/r/codex:/r/claude"],
    ["not an array", '{"home":"/r/codex"}'],
    ["a relative path", '["r/codex"]'],
  ])("a list that is %s stops every launch", (_case, list) => {
    vi.stubEnv(homeGuardHomesKey, list);
    expect(homeGuardScript()).toContain("exit 97");
  });
});

/** What a startup file adds, in zsh and in a POSIX `sh` profile. */
type Tail = { readonly zsh: string; readonly sh: string };
const both = (line: string): Tail => ({ zsh: line, sh: line });

/** How the guarded login `shell`, started in `root`, ended under a startup-file `tail`. */
async function launchWith(shell: string, tail: (root: string) => Tail, list?: string) {
  const root = realpathSync(tempDir("home-guard-root:"));
  const home = tempDir("home-guard-home-");
  const homes = ["codex", "claude", "other", "user-home"].map((name) => join(root, name));
  for (const dir of homes) mkdirSync(dir);
  const [codex = "", claude = "", other = ""] = homes;
  const { zsh, sh } = tail(root);
  writeFileSync(join(home, ".zshrc"), `${zsh}\n`);
  for (const name of [".bash_profile", ".profile"]) writeFileSync(join(home, name), `${sh}\n`);
  vi.stubEnv(homeGuardHomesKey, list ?? JSON.stringify([codex, claude, other]));
  vi.stubEnv("CODEX_HOME", codex);
  vi.stubEnv("CLAUDE_CONFIG_DIR", claude);
  const { ZDOTDIR: _zdotdir, CDPATH: _cdpath, ...inherited } = process.env;
  const pty = nodePtyFactory({
    command: shell,
    args: loginShellCommand("printf 'command ran\\n'"),
    cwd: root,
    env: { ...inherited, HOME: home },
    size: { cols: 200, rows: 10 },
  });
  let output = "";
  pty.onData((chunk) => {
    output += chunk;
  });
  const exitCode = await new Promise<number>((done) =>
    pty.onExit(({ exitCode }) => done(exitCode)),
  );
  return { exitCode, output };
}

describe.each(loginShells)("C-E2E-24 a guarded login shell (%s)", (shell) => {
  test("runs its command when its startup files keep every guarded home", async () => {
    const { exitCode, output } = await launchWith(shell, () => both(":"));
    expect(output).toContain("command ran");
    expect(exitCode).toBe(0);
  });

  test("runs its command when a startup file moves a home to another registered one, by a relative name", async () => {
    // A `CDPATH` entry holding an `other` that is not registered, a `cd` function, and a
    // zsh `chpwd` hook that prints and moves must not change what the name resolves to.
    const decoy = tempDir("home-guard-decoy-");
    mkdirSync(join(decoy, "other"));
    const line = `cd() { echo cd function; }; export CDPATH=${shellQuote(decoy)} CODEX_HOME=other`;
    const { exitCode, output } = await launchWith(shell, () => ({
      zsh: `chpwd() { echo hook output; builtin cd -q /; }; ${line}`,
      sh: line,
    }));
    expect(output).toContain("command ran");
    expect(exitCode).toBe(0);
  });

  test.each<[string, (root: string) => Tail]>([
    ["replaces a guarded home", () => both('export CODEX_HOME="$HOME/.codex"')],
    ["unsets a guarded home", () => both("unset CLAUDE_CONFIG_DIR")],
    // POSIX sh cannot unexport, so its profile unsets instead.
    [
      "unexports a guarded home",
      () => ({
        zsh: "typeset +x CODEX_HOME",
        sh: "export -n CODEX_HOME 2>/dev/null || unset CODEX_HOME",
      }),
    ],
    // The user's own home could sit under the suite's temp dir: being near a registered home
    // is not enough.
    [
      "points a guarded home at an unregistered directory beside the registered ones",
      (root) => both(`export CODEX_HOME=${shellQuote(join(root, "user-home"))}`),
    ],
    ["leads a guarded home out through `..`", () => both('export CODEX_HOME="$CODEX_HOME/../.."')],
    ["ends a guarded home in `..`", () => both('export CODEX_HOME="$CODEX_HOME/.."')],
    [
      "points a guarded home at a link to another directory",
      (root) => {
        symlinkSync(tempDir("home-guard-outside-"), join(root, "link"));
        return both(`export CODEX_HOME=${shellQuote(join(root, "link"))}`);
      },
    ],
    // Only a launch in a terminal, as every session's is, takes this branch.
    [
      "moves a guarded home only in a terminal",
      () => both('[ -t 0 ] && export CODEX_HOME="$HOME/.codex"'),
    ],
    // The stop line goes to the terminal itself, which no redirection of the shell's own
    // output can hide.
    [
      "hides the shell's stdout and stderr, then moves a guarded home",
      () => both('exec >/dev/null 2>&1; export CODEX_HOME="$HOME/.codex"'),
    ],
  ])("stops before its command when a startup file %s", async (_case, tail) => {
    const { exitCode, output } = await launchWith(shell, tail);
    expect(output).not.toContain("command ran");
    expect(output).toContain(`${homeGuardStopLine}: the login shell left`);
    expect(exitCode).toBe(97);
  });

  test("stops before its command when the list of homes cannot be read", async () => {
    const { exitCode, output } = await launchWith(shell, () => both(":"), "/r/codex:/r/claude");
    expect(output).not.toContain("command ran");
    expect(output).toContain(`${homeGuardStopLine}: ${homeGuardHomesKey} is not a JSON array`);
    expect(exitCode).toBe(97);
  });
});
