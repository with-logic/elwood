/**
 * A cleanup record that cannot be written must not strand the lease for the owner host's
 * lifetime (PRD §9.2, C-PERF-04). The owner is a real, long-lived host process whose owner
 * writes all fail, holding a real updater process group.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test, vi } from "vitest";
import { processGroupGone } from "../../../src/runtime/probe-cleanup.ts";
import { coordinatedAutoupdate, updateLockPath } from "../../../src/runtime/update/lock.ts";
import { tempDir } from "../../helpers/tmp.ts";

const moduleUrl = (path: string) =>
  JSON.stringify(pathToFileURL(fileURLToPath(new URL(path, import.meta.url))).href);

const ownerHost = `
  import fs from "node:fs";
  import { spawn } from "node:child_process";
  import { syncBuiltinESMExports } from "node:module";
  const root = process.env.ELWOOD_TEST_LOCK_ROOT;
  const { rename } = fs.promises;
  fs.promises.rename = (from, to) =>
    String(from).includes("owner.next.")
      ? Promise.reject(Object.assign(new Error("disk failed"), { code: "EIO" }))
      : rename(from, to);
  syncBuiltinESMExports();
  const { coordinatedAutoupdate } = await import(${moduleUrl("../../../src/runtime/update/lock.ts")});
  const { elwoodError } = await import(${moduleUrl("../../../src/core/errors.ts")});
  const updater = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], {
    detached: true,
    stdio: "ignore",
  });
  fs.writeFileSync(root + "/group", String(updater.pid));
  const aborted = elwoodError("codex_update_failed", "aborted", { cleanupProcessGroupId: updater.pid });
  await coordinatedAutoupdate("codex", () => Promise.reject(aborted), { root, retainRetryMs: 20 })
    .catch(() => undefined);
  fs.writeFileSync(root + "/settled", "settled");
  setTimeout(() => {}, 20000);
`;

test("C-PERF-04 a failed cleanup write releases the lease once the updater group exits, while the owner host lives", async () => {
  const root = tempDir("elwood-update-stranded-");
  const host = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", ownerHost], {
    env: { ...process.env, ELWOOD_TEST_LOCK_ROOT: root },
    stdio: "ignore",
  });
  const update = vi.fn(() => Promise.resolve());
  let group: number | undefined;
  try {
    await expect.poll(() => existsSync(join(root, "settled")), { timeout: 10_000 }).toBe(true);
    group = Number(readFileSync(join(root, "group"), "utf8"));
    expect(processGroupGone(group)).toBe(false);
    // The live group still holds exclusion through the owner's unreplaced record.
    await expect(
      coordinatedAutoupdate("codex", update, { root, pollMs: 5, waitMs: 100 }),
    ).rejects.toMatchObject({ details: { updateReason: "active_owner" } });
    process.kill(-group, "SIGKILL");
    await expect.poll(() => processGroupGone(group as number)).toBe(true);
    // The owner host is still alive, yet its lease ends with the group it was held for.
    await expect
      .poll(() => existsSync(updateLockPath("codex", root)), { timeout: 5_000 })
      .toBe(false);
    expect(host.exitCode).toBeNull();
    await coordinatedAutoupdate("codex", update, { root, pollMs: 5, waitMs: 100 });
    expect(update).toHaveBeenCalledOnce();
  } finally {
    host.kill("SIGKILL");
    if (group !== undefined && !processGroupGone(group)) process.kill(-group, "SIGKILL");
  }
});
