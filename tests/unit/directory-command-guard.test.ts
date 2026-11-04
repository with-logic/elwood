/** Child-side directory guards preserve login-shell behavior (PRD §4.2, C-API-61). */
import { spawnSync } from "node:child_process";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  directoryGuardExitCode,
  wrapCommandWithDirectoryGuard,
} from "../../src/core/checked-command.ts";
import { tempDir } from "../helpers/tmp.ts";

const identity = (path: string) => {
  const { dev, ino } = statSync(path, { bigint: true });
  return { dev, ino };
};

test("C-API-61 unchecked commands preserve their arguments", () => {
  const args = ["-c", "printf unchanged"];
  expect(wrapCommandWithDirectoryGuard("/bin/sh", args, "/missing", undefined, false)).toEqual({
    command: "/bin/sh",
    args,
  });
});

test.each([
  "darwin",
  "linux",
] as const)("C-API-61 uses %s's fixed stat format without a PATH lookup", (platform) => {
  const launch = wrapCommandWithDirectoryGuard(
    "/bin/sh",
    ["-c", "echo"],
    "/work",
    { dev: 1n, ino: 2n },
    false,
    platform,
  );
  expect(launch.args.join(" ")).toContain(
    `/usr/bin/stat -L ${platform === "darwin" ? "-f" : "-c"} '%d:%i'`,
  );
});

test("C-API-61 a mismatched kernel cwd executes neither profile nor requested command", () => {
  const expected = tempDir("elwood-checked-original-");
  const replacement = tempDir("elwood-checked-replacement-");
  const marker = join(replacement, "profile-ran");
  const script = join(replacement, "login-shell");
  writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  const launch = wrapCommandWithDirectoryGuard(
    script,
    ["-l", "-i", "-c", "exit 0"],
    expected,
    identity(expected),
    true,
  );
  const result = spawnSync(launch.command, launch.args, { cwd: replacement, encoding: "utf8" });
  expect(result.status).toBe(directoryGuardExitCode);
  expect(spawnSync("/bin/test", ["-e", marker]).status).toBe(1);
});

test("C-API-61 a profile's deliberate cd remains the command's effective directory", () => {
  const cwd = tempDir("elwood-checked-cwd-");
  const moved = tempDir("elwood-profile-cd-");
  const shell = join(cwd, "login-shell");
  writeFileSync(shell, `#!/bin/sh\ncd '${moved}'\nshift 3\neval "$1"\n`, { mode: 0o700 });
  const launch = wrapCommandWithDirectoryGuard(
    shell,
    ["-l", "-i", "-c", "/bin/pwd -P"],
    cwd,
    identity(cwd),
    true,
  );
  const result = spawnSync(launch.command, launch.args, { cwd, encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe(
    spawnSync("/bin/pwd", ["-P"], { cwd: moved, encoding: "utf8" }).stdout.trim(),
  );
});

test("C-API-61 unsupported stat dialects refuse only identity-bound launches", () => {
  const args = ["-c", "echo"];
  expect(wrapCommandWithDirectoryGuard("/bin/sh", args, "/work", undefined, true, "win32")).toEqual(
    {
      command: "/bin/sh",
      args,
    },
  );
  expect(() =>
    wrapCommandWithDirectoryGuard("/bin/sh", args, "/work", { dev: 1n, ino: 2n }, false, "win32"),
  ).toThrow("do not support win32");
});

test.each([
  [],
  ["-l", "-i", "-c"],
  ["-l", "-i", "-c", "echo", "extra"],
  ["-x", "-i", "-c", "echo"],
  ["-l", "-x", "-c", "echo"],
  ["-l", "-i", "-x", "echo"],
])("C-API-61 malformed login-shell args %j cannot silently lose the guard", (...args) => {
  expect(() =>
    wrapCommandWithDirectoryGuard("/bin/sh", args, "/work", { dev: 1n, ino: 2n }, true),
  ).toThrow("Expected login-shell arguments");
});

test("C-API-61 a sparse login-shell script position cannot omit the guard", () => {
  const args = ["-l", "-i", "-c"];
  args.length = 4;
  expect(() =>
    wrapCommandWithDirectoryGuard("/bin/sh", args, "/work", { dev: 1n, ino: 2n }, true),
  ).toThrow("Expected login-shell arguments");
});
