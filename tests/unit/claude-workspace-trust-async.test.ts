/** Exercise bounded async capture and cancellation of Claude filesystem evidence (PRD §5.1). */
import { realpathSync, statSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { assert, expect, test, vi } from "vitest";
import {
  captureClaudeStartupTrustEvidence,
  captureClaudeWorkspaceTrustTarget,
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
  const evidence = await captureClaudeWorkspaceTrustTarget(directory);
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
