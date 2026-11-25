/** Verify that optional Codex Git proof cannot hold launch while metadata is stalled (PRD §5.5). */
import { realpathSync, statSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import * as gitPaths from "../../src/codex/workspace-trust/git-paths.ts";
import {
  captureLaunchTrustEvidence,
  captureStartupTrustEvidence,
} from "../../src/codex/workspace-trust/launch-evidence.ts";
import { boundedTrustEvidence } from "../../src/core/trust/evidence-deadline.ts";
import { tempDir } from "../helpers/tmp.ts";

vi.mock("node:fs/promises", { spy: true });
vi.mock("../../src/codex/workspace-trust/git-paths.ts", { spy: true });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("startup stops waiting for a stalled Git metadata lookup", async () => {
  const cwd = realpathSync.native(tempDir("elwood-codex-trust-deadline-"));
  const original = (await vi.importActual<typeof fsp>("node:fs/promises")).lstat;
  const reached = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  vi.mocked(fsp.lstat).mockImplementation(async (...options) => {
    reached.resolve();
    await held.promise;
    return Reflect.apply(original, undefined, options);
  });

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const capture = captureStartupTrustEvidence({
    agent: "codex",
    cwd,
    identity: statSync(cwd, { bigint: true }),
  });
  try {
    await reached.promise;
    expect(fsp.lstat).toHaveBeenCalledExactlyOnceWith(join(cwd, ".git"));
    await vi.advanceTimersByTimeAsync(500);
    await expect(capture).resolves.toBeUndefined();
  } finally {
    held.resolve();
  }
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

test("cancellation during the last path lookup withholds captured and revalidated evidence", async () => {
  const cwd = realpathSync.native(tempDir("elwood-codex-trust-abort-"));
  const launch = { agent: "codex" as const, cwd, identity: statSync(cwd, { bigint: true }) };
  const captured = await captureLaunchTrustEvidence(launch);
  const native = (
    await vi.importActual<typeof gitPaths>("../../src/codex/workspace-trust/git-paths.ts")
  ).canonicalGitPath;

  for (const operation of ["capture", "revalidate"] as const) {
    const reached = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const signal = new AbortController();
    const realpath = vi.mocked(gitPaths.canonicalGitPath);
    realpath.mockImplementationOnce(native);
    if (operation === "capture") realpath.mockImplementationOnce(native);
    realpath.mockImplementationOnce(async (path, abortSignal) => {
      const result = await native(path, abortSignal);
      reached.resolve();
      await held.promise;
      return result;
    });
    const pending =
      operation === "capture"
        ? captureLaunchTrustEvidence(launch, signal.signal).then(
            ({ targets }) => targets.length > 0,
          )
        : captured.isCurrent(signal.signal);
    await reached.promise;
    signal.abort();
    held.resolve();
    await expect(pending).resolves.toBe(false);
  }
});
