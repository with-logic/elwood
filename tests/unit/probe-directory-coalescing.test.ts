/** Captured identities share queued probes without trusting mismatched settled answers (C-PERF-02). */
import { mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  createDirectoryProbeCache,
  readInDirectory,
} from "../../src/runtime/probe/directory-key.ts";
import { runProbe } from "../../src/runtime/probe/index.ts";
import { withProbeSlot } from "../../src/runtime/probe/slots.ts";
import type { CommandOptions, CommandResult } from "../../src/runtime/seams.ts";
import { shellQuote } from "../../src/runtime/shell.ts";
import { tempDir } from "../helpers/tmp.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
});
afterEach(() => vi.clearAllMocks());

function workspace() {
  const root = tempDir("elwood-cache-queued-");
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  return { cwd, original: join(root, "original"), identity: statSync(cwd, { bigint: true }), root };
}

test.each([
  false,
  true,
])("C-PERF-02 a mismatched follower shares the captured key with a matching leader (%s)", async (matchingLeader) => {
  const { cwd, original, identity, root } = workspace();
  const gate = Promise.withResolvers<void>();
  const holders = Array.from({ length: 8 }, () => withProbeSlot(() => gate.promise));
  const cache = createDirectoryProbeCache<CommandResult>(3);
  const queued = Promise.withResolvers<void>();
  const marker = join(root, "commands");
  const command = `printf 'run\n' >> ${shellQuote(marker)}; printf value`;
  const read = (options: CommandOptions) => {
    queued.resolve();
    return runProbe("/bin/sh", ["-c", command], options);
  };
  const at = () => readInDirectory(cache, cwd, read, identity);
  const pending: Promise<CommandResult>[] = [];
  const replace = () => {
    renameSync(cwd, original);
    mkdirSync(cwd);
  };
  try {
    if (!matchingLeader) replace();
    pending.push(at());
    await queued.promise;
    if (matchingLeader) replace();
    pending.push(at());
    // Observe both real initial stat calls before restoring or releasing the eight slots.
    const snapshots = vi.mocked(stat);
    await vi.waitFor(() => {
      expect(snapshots.mock.calls.filter(([path]) => path === cwd)).toHaveLength(2);
    });
    await Promise.all(
      snapshots.mock.calls.flatMap(([path], index) => {
        const result = snapshots.mock.results[index];
        return path === cwd && result?.type === "return" ? [result.value] : [];
      }),
    );
    renameSync(cwd, join(root, "replacement"));
    renameSync(original, cwd);
    gate.resolve();
    await expect(Promise.all(pending)).resolves.toEqual([
      { status: 0, stdout: "value", stderr: "" },
      { status: 0, stdout: "value", stderr: "" },
    ]);
    expect(readFileSync(marker, "utf8")).toBe("run\n");
    await at();
    expect(readFileSync(marker, "utf8")).toBe(matchingLeader ? "run\n" : "run\nrun\n");
  } finally {
    gate.resolve();
    await Promise.allSettled([...holders, ...pending]);
  }
});

test("C-PERF-02 a mismatch bypasses an original identity's settled answer and retention", async () => {
  const { cwd, original, identity } = workspace();
  const cache = createDirectoryProbeCache<number>(3);
  let reads = 0;
  const read = async () => ++reads;
  expect(await readInDirectory(cache, cwd, read, identity)).toBe(1);
  renameSync(cwd, original);
  mkdirSync(cwd);
  expect(await readInDirectory(cache, cwd, read, identity)).toBe(2);
  expect(await readInDirectory(cache, cwd, read, identity)).toBe(3);
});
