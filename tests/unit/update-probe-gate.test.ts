/** Probe execution waits for durable lease identity (PRD §9.2, C-PERF-04). */
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { elwoodError, probeFailureDetails } from "../../src/core/errors.ts";
import { runProbe, setProbeTimeoutMsForTests } from "../../src/runtime/probe.ts";
import { coordinatedAutoupdate, updateLockPath } from "../../src/runtime/update/lock.ts";
import { readOwner } from "../../src/runtime/update/owner.ts";
import { tempDir } from "../helpers/tmp.ts";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

afterEach(() => vi.restoreAllMocks());

function update(root: string, script: string): Promise<void> {
  return coordinatedAutoupdate(
    "codex",
    async () => {
      const result = await runProbe(process.execPath, ["-e", script]);
      if (result.status !== 0)
        throw elwoodError("codex_update_failed", "failed", probeFailureDetails(result));
    },
    { root, pollMs: 1, staleMs: 0 },
  );
}

test("C-PERF-04 registration failure never executes the updater", async () => {
  const root = tempDir("elwood-gate-");
  const marker = join(root, "mutated");
  const original = fs.rename;
  vi.spyOn(fs, "rename").mockImplementation((from, to) => {
    if (String(from).endsWith("owner.next"))
      return Promise.reject(Object.assign(new Error("registration"), { code: "EIO" }));
    return original(from, to);
  });
  await expect(
    update(root, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`),
  ).rejects.toMatchObject({ details: { errno: "EIO" } });
  await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.stat(updateLockPath("codex", root))).rejects.toMatchObject({ code: "ENOENT" });
});

test("C-PERF-04 registered live owners remain a wait condition, then skip the duplicate", async () => {
  const root = tempDir("elwood-gate-");
  const first = update(root, "setTimeout(() => {}, 100)");
  await expect
    .poll(async () => (await readOwner(updateLockPath("codex", root)))?.activeProbe)
    .toBe(true);
  let settled = false;
  const duplicate = vi.fn(() => Promise.resolve());
  const second = coordinatedAutoupdate("codex", duplicate, { root, pollMs: 1, staleMs: 0 }).then(
    () => {
      settled = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(settled).toBe(false);
  await Promise.all([first, second]);
  expect(duplicate).not.toHaveBeenCalled();
});

test("C-PERF-04 failed cleanup marking preserves the pre-registered group and typed diagnostics", async () => {
  const root = tempDir("elwood-gate-");
  setProbeTimeoutMsForTests(50);
  const rename = fs.rename;
  let writes = 0;
  vi.spyOn(fs, "rename").mockImplementation((from, to) => {
    if (String(from).endsWith("owner.next") && writes++ > 0)
      return Promise.reject(new Error("disk failed"));
    return rename(from, to);
  });
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("private"), { code: "EPERM" });
  });
  await expect(update(root, "setInterval(() => {}, 1000)")).rejects.toMatchObject({
    details: { errno: "ETIMEDOUT", cleanupErrorCode: "EPERM" },
  });
  const owner = await readOwner(updateLockPath("codex", root));
  expect(owner?.cleanupGroup).toBeGreaterThan(0);
  expect(owner?.activeProbe).toBe(true);
  kill.mockImplementation((pid) => {
    throw Object.assign(new Error("state"), { code: pid > 0 ? "ESRCH" : "EPERM" });
  });
  const duplicate = vi.fn(() => Promise.resolve());
  await expect(
    coordinatedAutoupdate("codex", duplicate, { root, pollMs: 1, staleMs: 0 }),
  ).rejects.toMatchObject({ code: "codex_update_failed" });
  expect(duplicate).not.toHaveBeenCalled();
});
