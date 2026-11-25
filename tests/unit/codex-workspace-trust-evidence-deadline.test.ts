/** Verify that optional Codex Git proof cannot hold launch while metadata is stalled (PRD §5.5). */
import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  captureLaunchTrustEvidence,
  captureStartupTrustEvidence,
} from "../../src/codex/workspace-trust/launch-evidence.ts";
import { boundedTrustEvidence } from "../../src/core/trust/evidence-deadline.ts";
import * as gitPaths from "../../src/core/trust/git-paths.ts";
import { tempDir } from "../helpers/tmp.ts";

vi.mock("node:fs/promises", { spy: true });
vi.mock("../../src/core/trust/git-paths.ts", { spy: true });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("startup times out during a descriptor read and closes it without another read", async () => {
  const cwd = realpathSync.native(tempDir("elwood-codex-trust-deadline-"));
  mkdirSync(join(cwd, ".git"));
  writeFileSync(join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
  const { open } = await vi.importActual<typeof fsp>("node:fs/promises");
  const opened = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const recordRead = vi.fn();
  vi.mocked(fsp.open).mockImplementationOnce(async (...args) => {
    const handle = await open(...args);
    const read = handle.read.bind(handle);
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "read")
      .mockImplementation((...args) => {
        recordRead();
        return read(...args);
      })
      .mockImplementationOnce(async () => {
        recordRead();
        opened.resolve();
        await held.promise;
        return { bytesRead: 1, buffer: Buffer.alloc(1) };
      });
    vi.spyOn(handle, "close").mockImplementationOnce(async () => {
      await close();
      closed.resolve();
    });
    return handle;
  });

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const capture = captureStartupTrustEvidence(checkedLaunch(cwd));
  try {
    await opened.promise;
    await vi.advanceTimersByTimeAsync(500);
    await expect(capture).resolves.toBeUndefined();
  } finally {
    held.resolve();
    await closed.promise;
  }
  expect(recordRead).toHaveBeenCalledOnce();
});

test("a timely capture preserves the exact checked launch target", async () => {
  const cwd = realpathSync.native(tempDir("elwood-codex-trust-proof-"));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const evidence = await captureStartupTrustEvidence({
    agent: "codex",
    cwd,
    identity: statSync(cwd, { bigint: true }),
  });
  expect(vi.getTimerCount()).toBe(0);
  expect(evidence?.targets[0]?.target).toEqual({ targetPath: cwd, targetScope: "folder" });
  await expect(evidence?.isCurrent()).resolves.toBe(true);
});

test("deadline returns unavailable and cancels a pending capture", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const cancelled = vi.fn();
  const capture = boundedTrustEvidence<never>(
    (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            cancelled();
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  );
  await Promise.all([expect(capture).resolves.toBeUndefined(), vi.advanceTimersByTimeAsync(500)]);
  expect(cancelled).toHaveBeenCalledOnce();
});

function checkedLaunch(cwd: string) {
  return { agent: "codex" as const, cwd, identity: statSync(cwd, { bigint: true }) };
}

async function holdCanonicalPathAfter(earlierCalls: number) {
  const native = (await vi.importActual<typeof gitPaths>("../../src/core/trust/git-paths.ts"))
    .canonicalTrustPath;
  const reached = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const realpath = vi.mocked(gitPaths.canonicalTrustPath);
  for (let index = 0; index < earlierCalls; index++) realpath.mockImplementationOnce(native);
  realpath.mockImplementationOnce(async (path, signal) => {
    const result = await native(path, signal);
    reached.resolve();
    await held.promise;
    return result;
  });
  return { reached: reached.promise, release: held.resolve };
}

test("a cancelled final capture lookup returns no trust targets", async () => {
  const cwd = realpathSync.native(tempDir("elwood-codex-trust-abort-"));
  const lookup = await holdCanonicalPathAfter(2);
  const stop = new AbortController();
  const pending = captureLaunchTrustEvidence(checkedLaunch(cwd), stop.signal);

  await lookup.reached;
  stop.abort();
  lookup.release();
  expect((await pending).targets).toEqual([]);
});

test("a cancelled final revalidation lookup withholds existing trust evidence", async () => {
  const cwd = realpathSync.native(tempDir("elwood-codex-trust-abort-"));
  const captured = await captureLaunchTrustEvidence(checkedLaunch(cwd));
  const lookup = await holdCanonicalPathAfter(1);
  const stop = new AbortController();
  const pending = captured.isCurrent(stop.signal);

  await lookup.reached;
  stop.abort();
  lookup.release();
  await expect(pending).resolves.toBe(false);
});

test("C-ATTN-07 closing discovery cancels pending proof and clears its deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const lifetime = new AbortController();
  const settled = Promise.withResolvers<true>();
  const capture = vi.fn((_signal: AbortSignal) => settled.promise);
  const checking = boundedTrustEvidence(capture, lifetime.signal);
  expect(vi.getTimerCount()).toBe(1);
  lifetime.abort();
  await expect(checking).resolves.toBeUndefined();
  expect(capture.mock.calls[0]?.[0].aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  await expect(boundedTrustEvidence(capture, lifetime.signal)).resolves.toBeUndefined();
  expect(capture).toHaveBeenCalledOnce();
  settled.resolve(true);
});
