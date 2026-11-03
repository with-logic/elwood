/** C-PERF-02 concurrent workspace callers share an update, then validate their own CLI. */
import { afterEach, expect, test } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import { preflightCodex } from "../../src/codex/preflight.ts";
import { setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import {
  resetAutoupdateForTests,
  setUpdateCoordinatorForTests,
} from "../../src/runtime/update/once.ts";
import { fakeLaunch, resetFakeLaunch } from "../helpers/fake-launch.ts";
import { tempDir } from "../helpers/tmp.ts";

afterEach(resetFakeLaunch);

test.each([
  { agent: "claude", preflight: preflightClaude, versions: ["1.1.0", "1.2.0"] },
  { agent: "codex", preflight: preflightCodex, versions: ["0.1.0", "0.2.0"] },
] as const)("C-PERF-02 $agent shares one blocked update across two workspaces", async ({
  agent,
  preflight,
  versions,
}) => {
  const owner = tempDir("elwood-update-owner-");
  const follower = tempDir("elwood-update-follower-");
  fakeLaunch();
  resetAutoupdateForTests();
  setUpdateCoordinatorForTests((_agent, update) => update());
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let updated = false;
  const updates: (string | undefined)[] = [];
  const postReads: (string | undefined)[] = [];
  setCommandRunnerForTests(async (_shell, args, options) => {
    if (args.join(" ").includes(`${agent} update`)) {
      updates.push(options?.cwd);
      entered.resolve();
      await release.promise;
      updated = true;
      return { status: 0, stdout: "", stderr: "" };
    }
    if (updated) postReads.push(options?.cwd);
    const version = updated ? (options?.cwd === owner ? versions[0] : versions[1]) : "2.1.144";
    return { status: 0, stdout: version, stderr: "" };
  });
  const first = preflight(true, true, owner);
  await entered.promise;
  const second = preflight(true, true, follower);
  const outcomes = Promise.allSettled([first, second]);
  expect(updates).toEqual([owner]);
  expect(postReads).toEqual([]);
  release.resolve();
  const results = await outcomes;
  for (const [index, result] of results.entries()) {
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reason).toMatchObject({
        code: `${agent}_version_unsupported`,
        details: agent === "claude" ? { found: versions[index] } : { version: versions[index] },
      });
    }
  }
  expect(updates).toEqual([owner]);
  expect(postReads.sort()).toEqual([owner, follower].sort());
});
