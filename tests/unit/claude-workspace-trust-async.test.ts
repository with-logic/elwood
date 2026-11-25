/** Exercise bounded async capture and cancellation of Claude filesystem evidence (PRD §5.1). */
import { realpathSync, statSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { assert, expect, test, vi } from "vitest";
import {
  captureClaudeLaunchTrustEvidence,
  captureClaudeStartupTrustEvidence,
} from "../../src/claude/workspace-trust/target.ts";
import { tempDir } from "../helpers/tmp.ts";

vi.mock("node:fs/promises", { spy: true });

function checkedFolder() {
  const cwd = realpathSync(tempDir());
  return { agent: "claude" as const, cwd, identity: statSync(cwd, { bigint: true }) };
}

test("the startup deadline accepts timely Claude scope evidence", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const directory = checkedFolder();
    const evidence = await captureClaudeStartupTrustEvidence(directory);
    expect(evidence?.scope.targetPath).toBe(directory.cwd);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("a canceled Claude recheck cannot return proof or revoke the next check", async () => {
  const directory = checkedFolder();
  const evidence = await captureClaudeLaunchTrustEvidence(directory);
  assert.isDefined(evidence);
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const lookup = join(directory.cwd, ".git");
  const mock = vi.mocked(lstat).mockImplementation(async (...options) => {
    if (options[0] === lookup) {
      started.resolve();
      await release.promise;
    }
    return Reflect.apply(actual.lstat, undefined, options);
  });
  const stop = new AbortController();
  try {
    const checking = evidence.isCurrent(stop.signal);
    await started.promise;
    stop.abort();
    release.resolve();
    expect(await checking).toBe(false);
  } finally {
    release.resolve();
    mock.mockRestore();
  }
  expect(await evidence.isCurrent()).toBe(true);
});

test("Claude startup stops waiting for stalled scope evidence before the lookup settles", async () => {
  const directory = checkedFolder();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const lookup = join(directory.cwd, ".git");
  const mock = vi.mocked(lstat).mockImplementation(async (...options) => {
    if (options[0] !== lookup) return Reflect.apply(actual.lstat, undefined, options);
    started.resolve();
    await release.promise;
    try {
      return await Reflect.apply(actual.lstat, undefined, options);
    } finally {
      finished.resolve();
    }
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const observed = vi.fn();
  const checking = captureClaudeStartupTrustEvidence(directory).then(observed);
  try {
    await started.promise;
    const pendingLookupCount = mock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(observed).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(vi.getTimerCount()).toBe(0);
    release.resolve();
    await finished.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mock).toHaveBeenCalledTimes(pendingLookupCount);
  } finally {
    release.resolve();
    await checking;
    mock.mockRestore();
    vi.useRealTimers();
  }
});
