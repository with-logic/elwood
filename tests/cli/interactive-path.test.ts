/** Foreground launch resolves the detected shell PATH without changing argv/status (C-CLI-25). */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { spawnInteractiveAgent } from "../../src/cli/interactive/spawn.ts";
import { loginShellResolves } from "../../src/cli/request/agent-detect.ts";
import {
  probeCommandTimeoutMs,
  probeLaunchTimeoutMs,
  resetProbeTimeoutsForTests,
  setProbeTimeoutsForTests,
} from "../../src/runtime/probe/index.ts";
import * as shell from "../../src/runtime/shell.ts";

const roots: string[] = [];
afterEach(() => {
  resetProbeTimeoutsForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "interactive-path-"));
  roots.push(root);
  const bin = join(root, "shell bin");
  mkdirSync(bin);
  const startup = join(root, "shell");
  writeFileSync(
    startup,
    `#!/bin/sh\nprintf 'startup noise\\n'\nexport PATH=${shell.shellQuote(bin)}:$PATH\nshift\nshift\nexec /bin/sh "$@"\n`,
    { mode: 0o700 },
  );
  vi.spyOn(shell, "userShell").mockReturnValue(startup);
  return { root, bin, startup };
}
test("C-CLI-25 shell-only executable resolves and receives literal arguments with exit 127 intact", async () => {
  const f = fixture();
  const output = join(f.root, "args");
  const name = "claude";
  writeFileSync(
    join(f.bin, name),
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${shell.shellQuote(output)}\nexit 127\n`,
    { mode: 0o700 },
  );
  expect(await loginShellResolves(name, f.startup)).toBe(true);
  expect(
    await spawnInteractiveAgent({
      agent: "claude",
      command: name,
      args: ["a b", "'quoted'", "$(false)"],
      cwd: f.root,
    }),
  ).toBe(127);
  expect(readFileSync(output, "utf8")).toBe("a b\n'quoted'\n$(false)\n");
});
test("C-CLI-25 failing shell startup maps to an adapter start error", async () => {
  const f = fixture();
  writeFileSync(f.startup, "#!/bin/sh\nexit 9\n");
  await expect(
    spawnInteractiveAgent({ agent: "codex", command: "unused", args: [], cwd: f.root }),
  ).rejects.toMatchObject({ code: "codex_start_failed" });
});

test.each([
  "",
  "printf 'startup noise'",
  "printf '\\0partial'",
])("C-CLI-25 successful shell exit without a complete frame preserves PATH (%s)", async (output) => {
  const f = fixture();
  writeFileSync(f.startup, `#!/bin/sh\n${output}\nexit 0\n`);
  writeFileSync(join(f.bin, "elwood-test-agent"), "#!/bin/sh\nexit 7\n", { mode: 0o700 });
  vi.stubEnv("PATH", f.bin);
  expect(
    await spawnInteractiveAgent({
      agent: "claude",
      command: "elwood-test-agent",
      args: [],
      cwd: f.root,
    }),
  ).toBe(7);
});
test("C-CLI-25 a framed empty PATH remains authoritative", async () => {
  const f = fixture();
  // The lookup itself runs, under an empty PATH: output the shell printed without running it
  // is startup output, never the lookup's (§9.2).
  writeFileSync(f.startup, '#!/bin/sh\nshift\nshift\nPATH= exec /bin/sh "$@"\n');
  writeFileSync(join(f.bin, "elwood-test-agent"), "#!/bin/sh\nexit 7\n", { mode: 0o700 });
  vi.stubEnv("PATH", f.bin);
  await expect(
    spawnInteractiveAgent({
      agent: "codex",
      command: "elwood-test-agent",
      args: [],
      cwd: f.root,
    }),
  ).rejects.toMatchObject({ code: "codex_not_found" });
});

test("C-PERF-05 interactive PATH lookup gives a slow profile the login shell's own bound", async () => {
  const f = fixture();
  const profile = readFileSync(f.startup, "utf8").replace("shift\n", "sleep 1\nshift\n");
  writeFileSync(f.startup, profile);
  writeFileSync(join(f.bin, "elwood-test-agent"), "#!/bin/sh\nexit 7\n", { mode: 0o700 });
  // The profile outlasts the command's bound and still resolves the shell's PATH.
  setProbeTimeoutsForTests({ commandMs: 300, launchMs: 10_000 });
  const launch = { agent: "claude", command: "elwood-test-agent", args: [], cwd: f.root } as const;
  expect(await spawnInteractiveAgent(launch)).toBe(7);
  // A profile that outlasts the launch bound fails as the login shell, not as a hang.
  setProbeTimeoutsForTests({ commandMs: 300, launchMs: 200 });
  await expect(spawnInteractiveAgent(launch)).rejects.toMatchObject({
    code: "claude_start_failed",
    details: { cause: expect.stringContaining("login shell did not start"), errno: "ETIMEDOUT" },
  });
});

test("C-CLI-25 a shell that fails after running the lookup maps to an adapter start error", async () => {
  const f = fixture();
  writeFileSync(f.startup, '#!/bin/sh\nshift\nshift\n/bin/sh "$@"\nexit 3\n');
  await expect(
    spawnInteractiveAgent({ agent: "codex", command: "unused", args: [], cwd: f.root }),
  ).rejects.toMatchObject({
    code: "codex_start_failed",
    details: { cause: "login shell exited with status 3" },
  });
});

/**
 * Real login shells and their startup file, each with a DEBUG trap that prints on both streams
 * and a `printf` function that prints a NUL-framed PATH of its own.
 */
const loginShells = [
  [
    "/bin/zsh",
    ".zshrc",
    "TRAPDEBUG() { echo FAKE-SECRET; echo FAKE-SECRET >&2 }\nprintf() { builtin printf '\\0/elsewhere\\0' }",
  ],
  [
    "/bin/bash",
    ".bash_profile",
    "trap 'echo FAKE-SECRET; echo FAKE-SECRET >&2' DEBUG\nprintf() { builtin printf '\\0/elsewhere\\0'; }",
  ],
] as const;

/**
 * A real login shell gets the lookup's full launch and command bounds, as in production: on a
 * loaded host its startup alone can take most of the launch bound. The agent itself exits at
 * once, so the test needs no more than the lookup can take.
 */
const realShellTestTimeoutMs = probeLaunchTimeoutMs + probeCommandTimeoutMs;

test.each(loginShells.filter(([path]) => existsSync(path)))(
  "C-CLI-25 %s hands the agent its login shell's own PATH, whatever its startup file defines",
  async (path, startupFile, startup) => {
    const home = mkdtempSync(join(tmpdir(), "interactive-path-"));
    roots.push(home);
    const bin = join(home, "agent bin");
    mkdirSync(bin);
    const seen = join(home, "path");
    const agent = `#!/bin/sh\nprintf '%s' "$PATH" > ${shell.shellQuote(seen)}\n`;
    writeFileSync(join(bin, "elwood-test-agent"), agent, { mode: 0o700 });
    // Set last, after the system startup files, so it is the login shell's whole PATH.
    const loginPath = `${bin}:/usr/bin:/bin`;
    writeFileSync(
      join(home, startupFile),
      `export PATH=${shell.shellQuote(loginPath)}\n${startup}\n`,
    );
    vi.stubEnv("HOME", home);
    vi.stubEnv("ZDOTDIR", home);
    vi.stubEnv("HISTFILE", join(home, ".history"));
    vi.stubEnv("TERM_PROGRAM", ""); // no Apple Terminal session hooks
    vi.stubEnv("PATH", "/usr/bin:/bin"); // only the login shell's PATH finds the agent
    vi.spyOn(shell, "userShell").mockReturnValue(path);
    const launch = { agent: "claude", command: "elwood-test-agent", args: [], cwd: home } as const;
    expect(await spawnInteractiveAgent(launch)).toBe(0);
    expect(readFileSync(seen, "utf8")).toBe(loginPath);
  },
  realShellTestTimeoutMs,
);
