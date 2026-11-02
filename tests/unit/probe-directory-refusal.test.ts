/** Pre-command directory refusals preserve diagnostics without inventing CLI failures (C-API-61). */

import { type BigIntStats, rmSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { directoryGuardExitCode } from "../../src/runtime/checked-command.ts";
import * as captures from "../../src/runtime/probe/capture.ts";
import {
  directoryShellExit,
  refusedProbeDirectory,
} from "../../src/runtime/probe/directory-key.ts";
import { runProbe } from "../../src/runtime/probe/index.ts";
import { probeScript } from "../../src/runtime/probe/start.ts";
import type { CommandResult } from "../../src/runtime/seams.ts";
import { tempDir } from "../helpers/tmp.ts";

// The shared preload imports the runner before this file installs its fs delay.
vi.hoisted(() => vi.resetModules());

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

afterEach(() => vi.restoreAllMocks());

test("C-PERF-01 a pending host stat leaves the event loop free before spawning", async () => {
  const cwd = tempDir("elwood-stat-check-");
  const identity = statSync(cwd, { bigint: true });
  const deferred = Promise.withResolvers<BigIntStats>();
  const pendingStat = vi.mocked(fs.stat).mockImplementationOnce(() => deferred.promise);
  let settled = false;
  const pending = refusedProbeDirectory({ cwd, identity }).then((result) => {
    settled = true;
    return result;
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    expect(pendingStat).toHaveBeenCalledWith(cwd, { bigint: true });
    expect(settled).toBe(false);
  } finally {
    deferred.resolve(identity);
  }
  expect(await pending).toBeUndefined();
});

test("C-API-61 status 96 without a pre-start shell failure remains the CLI's own status", () => {
  const result = { status: directoryGuardExitCode, stdout: "cli", stderr: "" };
  expect(directoryShellExit(96, result, {}, "/bin/sh")).toBe(result);
  expect(
    directoryShellExit(
      96,
      result,
      { cwd: "/work", identity: { dev: 1n, ino: 2n } },
      "/bin/sh",
      true,
    ),
  ).toBe(result);
  expect(
    directoryShellExit(96, result, { cwd: "/work", identity: { dev: 1n, ino: 2n } }, "/bin/sh"),
  ).toBe(result);
});

test("C-API-61 a status-96 pre-start shell failure retains its message and checked cwd", () => {
  const error = { message: "guard refused", phase: "login_shell" } as const;
  const result: CommandResult = { status: null, stdout: "", stderr: "", error };
  expect(
    directoryShellExit(
      96,
      result,
      { cwd: "/work", identity: { dev: 1n, ino: 2n } },
      "/bin/sh",
      true,
    ),
  ).toEqual({ ...result, started: false, error: { ...error, cwd: "/work" } });
});

test("C-API-61 an invalid guarded shell layout releases its real private output capture", async () => {
  const cwd = tempDir("elwood-invalid-login-");
  const identity = statSync(cwd, { bigint: true });
  const args = ["-c", probeScript("true")];
  const capture = await captures.probeCapture(args);
  const released = vi.spyOn(capture, "release");
  vi.spyOn(captures, "probeCapture").mockResolvedValue(capture);
  try {
    await expect(runProbe("/bin/sh", args, { cwd, identity })).rejects.toThrow(
      "Expected login-shell arguments",
    );
    expect(released).toHaveBeenCalledOnce();
  } finally {
    capture.release();
  }
});

test("C-API-61 host stat and identity refusals are marked unstarted with their actual reason", async () => {
  const cwd = tempDir("elwood-refused-directory-");
  const identity = statSync(cwd, { bigint: true });
  const replaced = await refusedProbeDirectory({
    cwd,
    identity: { dev: identity.dev, ino: identity.ino + 1n },
  });
  expect(replaced).toMatchObject({
    started: false,
    error: { cwd, message: "The directory was removed or replaced before the probe started." },
  });
  rmSync(cwd, { recursive: true });
  expect(await refusedProbeDirectory({ cwd, identity })).toMatchObject({
    started: false,
    error: { cwd, code: "ENOENT", message: expect.stringContaining("ENOENT") },
  });
});
