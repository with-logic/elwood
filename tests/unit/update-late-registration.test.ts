/** Cleanup ownership is final: no late active registration replaces it (PRD §9.2, C-PERF-04). */
import { existsSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { runProbe, setProbeTimeoutMsForTests } from "../../src/runtime/probe.ts";
import { processGroupGone } from "../../src/runtime/probe-cleanup.ts";
import { coordinatedAutoupdate, updateLockPath } from "../../src/runtime/update/lock.ts";
import { readOwner } from "../../src/runtime/update/owner.ts";
import { ProbeRegistration } from "../../src/runtime/update/probe-registration.ts";
import { tempDir } from "../helpers/tmp.ts";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

afterEach(() => vi.restoreAllMocks());

const fixture = fileURLToPath(new URL("../fixtures/probe-descendant.ts", import.meta.url));

test("C-PERF-04 a registration landing after cleanup cannot restore the active record", async () => {
  const root = tempDir("elwood-late-registration-");
  const leader = join(root, "leader");
  const { rename } = fs;
  const release = Promise.withResolvers<void>();
  const landed = Promise.withResolvers<void>();
  let ownerWrites = 0;
  // Only the second probe's registration is slow; it commits after the callback settled.
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    const late = String(from).includes("owner.next.") && ++ownerWrites === 2;
    if (late) await release.promise;
    await rename(from, to);
    if (late) landed.resolve();
  });
  try {
    await expect(
      coordinatedAutoupdate(
        "codex",
        async () => {
          await runProbe(process.execPath, ["--no-warnings", fixture, "leader", root]);
          setProbeTimeoutMsForTests(50);
          await runProbe(process.execPath, ["-e", ""]);
        },
        { root },
      ),
    ).rejects.toMatchObject({ details: { cleanupErrorCode: "ETIMEDOUT" } });
    release.resolve();
    await landed.promise;
    const group = Number(readFileSync(leader, "utf8"));
    // Group-only liveness: exclusion must end with the descendants, not with this host.
    await expect
      .poll(() => readOwner(updateLockPath("codex", root)))
      .toMatchObject({ cleanupGroups: [group], callbackOwnsLease: false });
    process.kill(-group, "SIGKILL");
    await expect.poll(() => processGroupGone(group)).toBe(true);
    const successor = vi.fn(() => Promise.resolve());
    await coordinatedAutoupdate("codex", successor, { root, pollMs: 5, staleMs: 0, waitMs: 2_000 });
    expect(successor).toHaveBeenCalledOnce();
  } finally {
    release.resolve();
    if (existsSync(leader)) {
      try {
        process.kill(-Number(readFileSync(leader, "utf8")), "SIGKILL");
      } catch {}
    }
  }
});

test("C-PERF-04 a registration begun after the callback settled is rejected unwritten", async () => {
  const registrar = vi.fn(() => Promise.resolve());
  const registry = new ProbeRegistration(registrar);
  await expect(registry.run(() => Promise.reject(new Error("update")))).rejects.toThrow("update");
  await expect(registry.register(1, new AbortController().signal)).rejects.toThrow("settled");
  expect(registrar).not.toHaveBeenCalled();
});
