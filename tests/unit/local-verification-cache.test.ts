/** C-PERF-02 / C-LIFE-11: local verification refusal preserves other workspaces' caches. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import {
  detectCodexCliCapabilities,
  preflightCodex,
  resetCodexPreflightCacheForTests,
} from "../../src/codex/preflight.ts";
import {
  UpdateVerificationFailure,
  verifyBeforeUpdate,
} from "../../src/core/update-verification.ts";
import { setCommandRunnerForTests, setPlatformForTests } from "../../src/runtime/seams.ts";
import { coordinatedAutoupdate, updateLockPath } from "../../src/runtime/update/lock.ts";
import {
  resetAutoupdateForTests,
  resetPreflightCacheForTests,
  setUpdateCoordinatorForTests,
} from "../../src/runtime/update/once.ts";
import { ownerFile, serializeOwner } from "../../src/runtime/update/owner.ts";
import { FAKE_PID } from "../helpers/fake-pid.ts";
import { tempDir } from "../helpers/tmp.ts";
import { spawnUpdateProcessGroup } from "../helpers/update-process-group.ts";

beforeEach(() => {
  resetAutoupdateForTests();
  resetPreflightCacheForTests();
  resetCodexPreflightCacheForTests();
  setPlatformForTests("darwin");
});
afterEach(resetCodexPreflightCacheForTests);

type VerificationMode =
  | "uncontended"
  | "recovered"
  | "unattested"
  | "completed"
  | "cleanup_pending"
  | "prior_refusal";
const states = [
  { mode: "uncontended", expectedReads: 1 },
  { mode: "recovered", expectedReads: 2 },
  { mode: "unattested", expectedReads: 2 },
  { mode: "completed", expectedReads: 2 },
  { mode: "cleanup_pending", expectedReads: 2 },
  { mode: "prior_refusal", expectedReads: 2 },
] satisfies readonly { readonly mode: VerificationMode; readonly expectedReads: number }[];

const cases = (
  [
    { agent: "claude", preflight: preflightClaude, version: "2.1.305" },
    { agent: "codex", preflight: preflightCodex, version: "codex-cli 0.150.0" },
  ] as const
).flatMap((adapter) => states.map((state) => ({ ...adapter, ...state })));
test.each(
  cases,
)("C-PERF-02 $agent refusal preserves healthy caches only with uncontended attestation ($mode)", async ({
  agent,
  preflight,
  version,
  mode,
  expectedReads,
}) => {
  const group = mode === "cleanup_pending" ? await spawnUpdateProcessGroup() : undefined;
  try {
    const root = tempDir("elwood-local-cache-lease-");
    const healthy = { cwd: tempDir("elwood-local-cache-healthy-") };
    const failing = { cwd: tempDir("elwood-local-cache-failing-") };
    setUpdateCoordinatorForTests((adapter, update) =>
      mode === "unattested"
        ? update()
        : coordinatedAutoupdate(adapter, update, { root, pollMs: 1, staleMs: 0 }),
    );
    let versionReads = 0;
    let helpReads = 0;
    let verificationReads = 0;
    let leaseHeldDuringVerification: boolean | undefined;
    let updates = 0;
    setCommandRunnerForTests((_shell, args, options) => {
      const command = args.join(" ");
      if (command.includes(`${agent} update`)) updates++;
      if (options?.cwd === failing.cwd) {
        if (++verificationReads === 1)
          leaseHeldDuringVerification = existsSync(updateLockPath(agent, root));
        return {
          status: 9,
          stdout: "",
          stderr: "verification refused",
          ...(group === undefined
            ? {}
            : {
                error: {
                  message: "verification cleanup pending",
                  cleanupErrorCode: "ETIMEDOUT" as const,
                  cleanupProcessGroupId: group.id,
                },
              }),
        };
      }
      expect(options?.cwd).toBe(healthy.cwd);
      if (command.includes("--help")) {
        helpReads++;
        return { status: 0, stdout: "--dangerously-bypass-hook-trust", stderr: "" };
      }
      versionReads++;
      return { status: 0, stdout: version, stderr: "" };
    });
    await preflight(true, false, healthy);
    if (agent === "codex")
      await expect(detectCodexCliCapabilities(healthy)).resolves.toEqual({
        supportsHookTrustBypass: true,
      });
    expect({ versionReads, helpReads }).toEqual({
      versionReads: 1,
      helpReads: agent === "codex" ? 1 : 0,
    });

    if (mode === "recovered" || mode === "prior_refusal") {
      const lease = updateLockPath(agent, root);
      mkdirSync(lease);
      writeFileSync(
        join(lease, ownerFile),
        serializeOwner({ pid: FAKE_PID, token: "00000000-0000-4000-8000-00000000000a" }),
      );
    }
    if (mode === "completed") await coordinatedAutoupdate(agent, () => Promise.resolve(), { root });
    if (mode === "prior_refusal") {
      await expect(
        coordinatedAutoupdate(
          agent,
          () =>
            verifyBeforeUpdate(
              () => Promise.reject(new Error("peer verification refused")),
              () => Promise.resolve(),
            ),
          { root, pollMs: 1, staleMs: 0 },
        ),
      ).rejects.toBeInstanceOf(UpdateVerificationFailure);
      expect(existsSync(updateLockPath(agent, root))).toBe(false);
      expect(existsSync(join(root, `${agent}.completed.refused`))).toBe(true);
    }
    await expect(preflight(true, true, failing)).rejects.toMatchObject({
      code: `${agent}_start_failed`,
    });
    expect(leaseHeldDuringVerification).toBe(mode !== "unattested");
    expect(verificationReads).toBe(2);
    expect(updates).toBe(0);
    expect(existsSync(updateLockPath(agent, root))).toBe(mode === "cleanup_pending");
    expect(existsSync(join(root, `${agent}.completed`))).toBe(mode === "completed");

    await preflight(true, false, healthy);
    if (agent === "codex")
      await expect(detectCodexCliCapabilities(healthy)).resolves.toEqual({
        supportsHookTrustBypass: true,
      });
    expect.soft(versionReads).toBe(expectedReads);
    expect.soft(helpReads).toBe(agent === "codex" ? expectedReads : 0);
  } finally {
    await group?.killGroup();
  }
});
