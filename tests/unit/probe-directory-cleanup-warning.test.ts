/** Persistent cleanup diagnostics stay bounded and content-free (PRD §9.2, C-PERF-05). */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { tempDir } from "../helpers/tmp.ts";

const fault = vi.hoisted(() => ({
  error: undefined as unknown,
  calls: 0,
  remove: undefined as string | undefined,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    chmod: async (...args: Parameters<typeof actual.chmod>) => {
      await actual.chmod(...args);
      fault.calls++;
      if (args[0] === fault.remove) {
        await actual.rm(fault.remove, { recursive: true, force: true });
        throw Object.assign(new Error("removed descendant"), { code: "ENOENT" });
      }
      if (fault.error !== undefined) throw fault.error;
    },
  };
});
beforeEach(() => {
  vi.resetModules();
  Object.assign(fault, { error: undefined, calls: 0, remove: undefined });
  vi.stubEnv("TMPDIR", tempDir("elwood-cleanup-warning-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function directory() {
  const cleanup = await import("../../src/runtime/probe/private-directory.ts");
  const path = cleanup.makePrivateDirectory();
  return { ...cleanup, path };
}

test("C-PERF-05 normal removal, repaired trees, and missing directories are silent", async () => {
  const report = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  const normal = await directory();
  writeFileSync(join(normal.path, "output"), "settled result");
  normal.removePrivateDirectory(normal.path, ["output"]);
  expect(existsSync(normal.path)).toBe(false);
  normal.removePrivateDirectory(normal.path, []);
  const tree = await directory();
  mkdirSync(join(tree.path, "left-by-command"));
  writeFileSync(join(tree.path, "left-by-command", "file"), "");
  tree.removePrivateDirectory(tree.path, []);
  await vi.waitFor(() => expect(existsSync(tree.path)).toBe(false));
  expect(fault.calls).toBeGreaterThan(0);
  expect(report).not.toHaveBeenCalled();
});

test("C-PERF-05 persistent failures emit one sanitized real Node warning per process", async () => {
  const report = vi.spyOn(process, "emitWarning");
  const observed = new Promise<Error>((resolve) => process.once("warning", resolve));
  const cleanup = await directory();
  mkdirSync(join(cleanup.path, "left-by-command"));
  fault.error = Object.assign(new Error(`SECRET output ${cleanup.path}`), {
    code: "EACCES",
    path: cleanup.path,
    stderr: "SECRET stderr",
  });
  cleanup.removePrivateDirectory(cleanup.path, []);
  const warning = await observed;
  expect(warning).toMatchObject({
    name: "ElwoodProbeCleanupWarning",
    code: "ELWOOD_PROBE_CLEANUP_FAILED",
    message: "A temporary probe output directory could not be removed.",
    stack: "ElwoodProbeCleanupWarning: A temporary probe output directory could not be removed.",
  });
  expect(Object.getOwnPropertyNames(warning).sort()).toEqual(["code", "message", "name", "stack"]);
  expect(String(warning.stack)).not.toContain(cleanup.path);
  cleanup.removePrivateDirectory(cleanup.path, []);
  await vi.waitFor(() => expect(fault.calls).toBe(2));
  await setImmediate();
  const second = await directory();
  mkdirSync(join(second.path, "another-failed-tree"));
  second.removePrivateDirectory(second.path, []);
  await vi.waitFor(() => expect(fault.calls).toBe(3));
  await setImmediate();
  expect(report).toHaveBeenCalledTimes(1);
});

test("C-PERF-05 a throwing reporter is contained and is not repeatedly attempted", async () => {
  const report = vi.spyOn(process, "emitWarning").mockImplementation(() => {
    throw new Error("reporter");
  });
  const cleanup = await directory();
  mkdirSync(join(cleanup.path, "left-by-command"));
  fault.error = new Error("failure without errno");
  expect(() => cleanup.removePrivateDirectory(cleanup.path, [])).not.toThrow();
  await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
  cleanup.removePrivateDirectory(cleanup.path, []);
  await vi.waitFor(() => expect(fault.calls).toBe(2));
  await setImmediate();
  expect(report).toHaveBeenCalledTimes(1);
});

test("C-PERF-05 a real probe retains its settled output and status after cleanup failure", async () => {
  const report = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  const { runProbe } = await import("../../src/runtime/probe/index.ts");
  const { probeShellCommand, shellQuote } = await import("../../src/runtime/shell.ts");
  fault.error = new Error("persistent cleanup");
  const command =
    'for d in "$TMPDIR"/elwood-probe-*; do mkdir "$d/tree"; done; printf ok; printf err >&2; exit 7';
  const args = probeShellCommand(`/bin/sh -c ${shellQuote(command)}`);
  const result = await runProbe("/bin/sh", ["-c", args[3]]);
  expect(result).toMatchObject({ status: 7, stdout: "ok", stderr: "err" });
  expect(result.error).toBeUndefined();
  await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
  expect(result).toMatchObject({ status: 7, stdout: "ok", stderr: "err" });
});

test("C-PERF-05 a vanished descendant does not strand its surviving probe directory", async () => {
  const report = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  const cleanup = await directory();
  const child = join(cleanup.path, "removed-during-walk");
  mkdirSync(child);
  mkdirSync(join(cleanup.path, "remaining"));
  fault.remove = child;
  cleanup.removePrivateDirectory(cleanup.path, []);
  await vi.waitFor(() => expect(existsSync(cleanup.path)).toBe(false));
  expect(fault.calls).toBeGreaterThan(1);
  expect(report).not.toHaveBeenCalled();
});
