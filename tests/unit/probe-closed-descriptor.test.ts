/**
 * A login shell that closes inherited descriptors at startup still announces its probe command
 * (PRD §9.2, C-PERF-05). macOS's /bin/bash 3.2 as an interactive login shell closes every
 * descriptor above stderr, so the start line cannot use descriptor 3 there and goes to stdout.
 * A `/bin/sh` stand-in that closes descriptor 3 covers that path on every host; the real
 * `/bin/bash -l -i` test runs only where /bin/bash is 3.x.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import { runProbe, setProbeTimeoutsForTests } from "../../src/runtime/probe/index.ts";
import { probeCommandStartLine } from "../../src/runtime/probe/start.ts";
import { setPlatformForTests } from "../../src/runtime/seams.ts";
import * as shell from "../../src/runtime/shell.ts";
import { resetPreflightCacheForTests } from "../../src/runtime/update/once.ts";
import { tempDir } from "../helpers/tmp.ts";

beforeEach(() => resetPreflightCacheForTests());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** A login shell that, like macOS bash 3.2 under `-l -i`, closes descriptor 3 before its script. */
function closingShell(profile = ""): string {
  const root = tempDir("elwood-closed-fd-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), "#!/bin/sh\necho '2.1.310 (Claude Code)'\n", { mode: 0o700 });
  const login = join(root, "login-shell");
  const path = `export PATH=${shell.shellQuote(bin)}:"$PATH"`;
  // Called as `login-shell -l -i -c <script>`, as `probeShellCommand` builds it.
  const body = `exec 3>&-\n${profile}\n${path}\nshift 3\nexec /bin/sh -c "$1"\n`;
  writeFileSync(login, `#!/bin/sh\n${body}`, { mode: 0o700 });
  return login;
}

test("C-PERF-05 a login shell that closed descriptor 3 still passes Claude's version probe", async () => {
  setPlatformForTests("darwin");
  vi.spyOn(shell, "userShell").mockReturnValue(closingShell());
  await expect(preflightClaude(process.cwd(), true)).resolves.toBeUndefined();
});

test.each([
  ["", "2.1.310\n"],
  ["printf noise", "2.1.310\n"],
  ["exec 2>/dev/null", "2.1.310\n"],
  ["exec 2>&1", "2.1.310\n"],
])("C-PERF-05 without descriptor 3 the start line goes to stdout and only the command's output is kept (%s)", async (profile, stdout) => {
  const result = await runProbe(closingShell(profile), shell.probeShellCommand("echo 2.1.310"));
  expect(result).toEqual({ status: 0, stdout, stderr: "" });
});

test("C-PERF-05 a start line on stdout ends the launch phase while the command still runs", async () => {
  // The launch bound would kill the probe mid-`sleep`; only the line hands it the command bound.
  setProbeTimeoutsForTests({ commandMs: 10_000, launchMs: 1_500 });
  const command = shell.probeShellCommand("/bin/sh -c 'sleep 2; echo 2.1.310'");
  const result = await runProbe(closingShell(), command);
  expect(result).toEqual({ status: 0, stdout: "2.1.310\n", stderr: "" });
});

test.each([
  "closed",
  "open",
])("C-PERF-05 a profile printing the bare start line does not start the command bound (descriptor 3 %s)", async (descriptor) => {
  // stdout is watched for every probe, so only the line's per-process token marks the start.
  setProbeTimeoutsForTests({ commandMs: 150, launchMs: 10_000 });
  const profile = "echo elwood-probe-command-start; sleep 0.6";
  const [, , , script] = shell.probeShellCommand("echo 2.1.310");
  const result = await (descriptor === "closed"
    ? runProbe(closingShell(profile), ["-l", "-i", "-c", script])
    : runProbe("/bin/sh", ["-c", `${profile}; ${script}`]));
  expect(result).toEqual({ status: 0, stdout: "2.1.310\n", stderr: "" });
});

// Pinned to the bash 3.2 that macOS ships as /bin/bash. Linux's bash 5.2 keeps descriptor 3 as
// an interactive login shell, so there this would pass without reaching the stdout path, which
// the stand-in above covers on every host.
const bash3 = spawnSync("/bin/bash", ["-c", "echo $BASH_VERSION"], {
  encoding: "utf8",
}).stdout?.startsWith("3.");

describe.skipIf(bash3 !== true)("real /bin/bash 3.x as the login shell", () => {
  test.each([
    "",
    "exec 2>/dev/null",
    "exec 2>&1",
  ])("C-PERF-05 `/bin/bash -l -i` starts the probe command (profile: %s)", async (profile) => {
    // A private HOME: bash reads only /etc/profile and this test's own ~/.bash_profile.
    const home = tempDir("elwood-bash-home-");
    writeFileSync(join(home, ".bash_profile"), `${profile}\n`);
    vi.stubEnv("HOME", home);
    vi.stubEnv("HISTFILE", join(home, ".bash_history"));
    vi.stubEnv("TERM_PROGRAM", ""); // no /etc/bashrc_Apple_Terminal session hooks
    const result = await runProbe("/bin/bash", shell.probeShellCommand("echo 2.1.310"));
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ status: 0, stdout: "2.1.310\n" });
    expect(result.stderr).not.toContain(probeCommandStartLine);
  });
});
