/** Real probe boundaries retain the original workspace identity (PRD §4.2, C-API-61). */
import * as childProcess from "node:child_process";
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { directoryGuardExitCode } from "../../src/core/directory-guard.ts";
import { shellQuote } from "../../src/runtime/shell.ts";
import { tempDir } from "../helpers/tmp.ts";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
}));

let runProbe: typeof import("../../src/runtime/probe/index.ts").runProbe;
let withProbeSlot: typeof import("../../src/runtime/probe/slots.ts").withProbeSlot;
let probeShellCommand: typeof import("../../src/runtime/shell.ts").probeShellCommand;
beforeEach(async () => {
  vi.resetModules();
  ({ runProbe } = await import("../../src/runtime/probe/index.ts"));
  ({ withProbeSlot } = await import("../../src/runtime/probe/slots.ts"));
  ({ probeShellCommand } = await import("../../src/runtime/shell.ts"));
});

function workspace() {
  const root = tempDir("elwood-identity-");
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  const { dev, ino } = statSync(cwd, { bigint: true });
  return { root, options: { cwd, directoryIdentity: { dev, ino } } };
}
function replace(cwd: string) {
  renameSync(cwd, `${cwd}-original`);
  mkdirSync(cwd);
}
function profile(script: string) {
  const home = tempDir("elwood-identity-profile-");
  writeFileSync(join(home, ".bash_profile"), script);
  vi.stubEnv("HOME", home);
  vi.stubEnv("TERM_PROGRAM", "");
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test("C-API-61 keeps capture paths valid inside a matching identity guard", async () => {
  profile("");
  const { options } = workspace();
  const spawn = vi.spyOn(childProcess, "spawn");
  expect(await runProbe("/bin/bash", probeShellCommand("/bin/echo wanted"), options)).toEqual({
    status: 0,
    stdout: "wanted\n",
    stderr: "",
  });
  const launch = spawn.mock.calls.find(([command]) => command === "/bin/sh");
  expect(launch?.[1]).toEqual(
    expect.arrayContaining([expect.stringContaining("elwood-probe-directory-refused-")]),
  );
  expect(JSON.stringify(launch)).not.toContain("/dev/tty");
});

test("C-API-61 retains native stat diagnostics when a pinned directory disappears", async () => {
  const { options } = workspace();
  renameSync(options.cwd, `${options.cwd}-original`);
  expect(await runProbe("/bin/echo", ["must-not-run"], options)).toMatchObject({
    status: null,
    stdout: "",
    stderr: "",
    error: { code: "ENOENT", syscall: "stat", path: options.cwd, origin: "probe_setup" },
  });
});

test("C-API-61 checks the supplied identity after waiting for a probe slot", async () => {
  const { root, options } = workspace();
  const marker = join(root, "ran");
  const opens: (() => void)[] = [];
  const holders = Array.from({ length: 8 }, () =>
    withProbeSlot(() => new Promise<void>((resolve) => opens.push(resolve))),
  );
  const spawn = vi.spyOn(childProcess, "spawn");
  const probe = runProbe("/bin/sh", ["-c", `touch ${shellQuote(marker)}`], options);
  try {
    replace(options.cwd);
  } finally {
    for (const open of opens) open();
  }
  await Promise.all(holders);
  expect(await probe).toMatchObject({ status: null, error: { origin: "probe_setup" } });
  expect(existsSync(marker)).toBe(false);
  expect(spawn).not.toHaveBeenCalled();
});

test("C-API-61 child guard refuses replacement after the host check before profiles", async () => {
  const { root, options } = workspace();
  const marker = join(root, "profile-ran");
  profile(`touch ${shellQuote(marker)}`);
  const spawn = childProcess.spawn;
  const spy = vi.spyOn(childProcess, "spawn").mockImplementation((...args) => {
    if (args[0] === "/bin/sh") {
      replace(options.cwd);
      spy.mockRestore();
    }
    return spawn(...args);
  });
  expect(
    await runProbe("/bin/bash", probeShellCommand("/bin/echo unwanted"), options),
  ).toMatchObject({ status: null, stdout: "", stderr: "", error: { origin: "probe_setup" } });
  expect(existsSync(marker)).toBe(false);
});

test("C-API-61 refuses a replacement performed by login profiles", async () => {
  const { options } = workspace();
  profile(
    `/bin/mv ${shellQuote(options.cwd)} ${shellQuote(`${options.cwd}-original`)}; /bin/mkdir ${shellQuote(options.cwd)}`,
  );
  expect(
    await runProbe("/bin/bash", probeShellCommand("/bin/echo unwanted"), options),
  ).toMatchObject({ status: null, stdout: "", stderr: "", error: { origin: "probe_setup" } });
});

test("C-API-61 closed control falls back to a visible stdout refusal marker", async () => {
  const { root, options } = workspace();
  const marker = join(root, "command-ran");
  profile(
    `exec 3>&-; /bin/mv ${shellQuote(options.cwd)} ${shellQuote(`${options.cwd}-original`)}; /bin/mkdir ${shellQuote(options.cwd)}`,
  );
  const result = await runProbe(
    "/bin/bash",
    probeShellCommand(`/usr/bin/touch ${shellQuote(marker)}`),
    options,
  );
  expect(result).toMatchObject({ status: null, error: { origin: "probe_setup" } });
  expect(existsSync(marker)).toBe(false);
});

test("C-API-61 allows a profile's deliberate directory change", async () => {
  const { root, options } = workspace();
  profile(`cd ${shellQuote(root)}`);
  expect(await runProbe("/bin/bash", probeShellCommand("/bin/pwd"), options)).toMatchObject({
    status: 0,
    stdout: `${root}\n`,
  });
});

test.each([
  `exit ${directoryGuardExitCode}`,
  `exec 3>&-; exec >/dev/null; exit ${directoryGuardExitCode}`,
])("C-API-61 profile status alone does not prove refusal (%s)", async (rc) => {
  const { options } = workspace();
  profile(rc);
  const result = await runProbe("/bin/bash", probeShellCommand("/bin/echo unwanted"), options);
  expect(result).not.toHaveProperty("started");
  expect(result).toMatchObject({
    status: null,
    error: { phase: "command_start_unobserved", shellStatus: directoryGuardExitCode },
  });
});

test("C-API-61 hidden guard refusal remains unknown rather than claiming no attempt", async () => {
  const { options } = workspace();
  profile(
    `exec 3>&-; exec >/dev/null; /bin/mv ${shellQuote(options.cwd)} ${shellQuote(`${options.cwd}-original`)}; /bin/mkdir ${shellQuote(options.cwd)}`,
  );
  const result = await runProbe("/bin/bash", probeShellCommand("/bin/echo unwanted"), options);
  expect(result).not.toHaveProperty("started");
  expect(result).toMatchObject({
    status: null,
    error: { phase: "command_start_unobserved", shellStatus: directoryGuardExitCode },
  });
});
