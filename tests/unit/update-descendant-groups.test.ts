/** Every registered probe group gates lease release on success and failure (PRD §9.2). */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { elwoodError, probeFailureDetails } from "../../src/core/errors.ts";
import { runProbe } from "../../src/runtime/probe.ts";
import { processGroupGone } from "../../src/runtime/probe-cleanup.ts";
import { coordinatedAutoupdate, updateLockPath } from "../../src/runtime/update/lock.ts";
import { tempDir } from "../helpers/tmp.ts";

const fixture = fileURLToPath(new URL("../fixtures/probe-descendant.ts", import.meta.url));
const probe = (mode: string, root: string) =>
  runProbe(process.execPath, ["--no-warnings", fixture, mode, root]);

const updates = {
  "a probe that exits non-zero leaves a descendant": async (root: string) => {
    const result = await probe("failed", root);
    throw elwoodError("codex_update_failed", `exit ${result.status}`, probeFailureDetails(result));
  },
  "an earlier probe's descendant outlives a later clean probe": async (root: string) => {
    const statuses = [await probe("leader", root), await runProbe(process.execPath, ["-e", ""])];
    if (statuses.some((result) => result.status !== 0)) throw new Error("probe fixture failed");
  },
};

test.each(
  Object.entries(updates),
)("C-PERF-04 exclusion holds until every registered group exits: %s", async (_name, update) => {
  const root = tempDir("elwood-descendant-groups-");
  const leader = join(root, "leader");
  try {
    const error = await coordinatedAutoupdate("codex", () => update(root), { root }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    const group = Number(readFileSync(leader, "utf8"));
    expect(error).toMatchObject({
      code: "codex_update_failed",
      details: { cleanupErrorCode: "ETIMEDOUT", cleanupProcessGroup: group },
    });
    expect(processGroupGone(group)).toBe(false);
    const owner = readFileSync(join(updateLockPath("codex", root), "owner"), "utf8");
    expect(owner.split(":")[2]?.split(",")).toContain(String(group));
    const duplicate = vi.fn(() => Promise.resolve());
    await expect(
      coordinatedAutoupdate("codex", duplicate, { root, pollMs: 5, waitMs: 100 }),
    ).rejects.toMatchObject({ details: { updateReason: "active_owner" } });
    process.kill(-group, "SIGKILL");
    await expect.poll(() => processGroupGone(group)).toBe(true);
    await coordinatedAutoupdate("codex", duplicate, { root, pollMs: 5, staleMs: 0 });
    expect(duplicate).toHaveBeenCalledOnce();
  } finally {
    if (existsSync(leader)) {
      try {
        process.kill(-Number(readFileSync(leader, "utf8")), "SIGKILL");
      } catch {}
    }
  }
});
