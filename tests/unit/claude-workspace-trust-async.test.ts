/** Exercise bounded async capture and cancellation of Claude filesystem evidence (PRD §5.1). */
import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
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

test("Claude startup cancels further reads from a stalled metadata descriptor", async () => {
  const directory = checkedFolder();
  const git = join(directory.cwd, ".git");
  const head = join(git, "HEAD");
  mkdirSync(git);
  writeFileSync(head, "ref: refs/heads/main\n");
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const reading = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const recordRead = vi.fn();
  const mock = vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    if (args[0] !== head) return handle;
    const read = handle.read.bind(handle);
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "read")
      .mockImplementation((...args) => {
        recordRead();
        return read(...args);
      })
      .mockImplementationOnce(async () => {
        recordRead();
        reading.resolve();
        await release.promise;
        return { bytesRead: 1, buffer: Buffer.alloc(1) };
      });
    vi.spyOn(handle, "close").mockImplementationOnce(async () => {
      await close();
      closed.resolve();
    });
    return handle;
  });

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const observed = vi.fn();
  const checking = captureClaudeStartupTrustEvidence(directory).then(observed);
  try {
    await reading.promise;
    await vi.advanceTimersByTimeAsync(500);
    expect(observed).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(vi.getTimerCount()).toBe(0);
    expect(recordRead).toHaveBeenCalledOnce();
  } finally {
    release.resolve();
    await checking;
    await closed.promise;
    mock.mockRestore();
    vi.useRealTimers();
  }
  expect(recordRead).toHaveBeenCalledOnce();
});
