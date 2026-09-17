/** Failed probe cleanup keeps updater exclusion across owners (PRD §9.2, C-PERF-04). */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { elwoodError, probeFailureDetails } from "../../src/core/errors.ts";
import { coordinatedAutoupdate, updateLockPath } from "../../src/runtime/update/lock.ts";
import { retainProbeOwner, unresolvedProbeGroup } from "../../src/runtime/update/owner.ts";
import { tempDir } from "../helpers/tmp.ts";

afterEach(() => vi.restoreAllMocks());

test("C-PERF-04 retain an unresolved group; contenders skip and recover only after group exit", async () => {
  const root = tempDir("elwood-update-cleanup-");
  const options = { root, pollMs: 1, staleMs: 0 };
  const group = 2147483600;
  const error = elwoodError(
    "codex_update_failed",
    "probe failed",
    probeFailureDetails({
      stderr: "",
      error: {
        message: "timed out",
        code: "ETIMEDOUT",
        cleanupErrorCode: "EPERM",
        cleanupProcessGroup: group,
      },
    }),
  );
  await expect(coordinatedAutoupdate("codex", () => Promise.reject(error), options)).rejects.toBe(
    error,
  );
  const path = updateLockPath("codex", root);
  const owner = await readFile(join(path, "owner"), "utf8");
  expect(owner).toMatch(new RegExp(`:${group}$`));
  // Parent death cannot evict a surviving updater's group.
  await writeFile(join(path, "owner"), owner.replace(/^\d+:/, "2147483599:"));
  const update = vi.fn(() => Promise.resolve());
  const signal = vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("cannot inspect"), { code: "EPERM" });
  });
  await expect(coordinatedAutoupdate("codex", update, options)).rejects.toMatchObject({
    code: "codex_update_failed",
    details: { cleanupErrorCode: "ETIMEDOUT" },
  });
  expect(update).not.toHaveBeenCalled();
  expect(await readFile(join(path, "owner"), "utf8")).toContain(`:${group}`);
  signal.mockImplementation(() => {
    throw Object.assign(new Error("gone"), { code: "ESRCH" });
  });
  await coordinatedAutoupdate("codex", update, options);
  expect(update).toHaveBeenCalledOnce();
});

test.each([
  new Error("plain"),
  undefined,
  "text",
  0,
  -1,
  1.5,
  "42",
])("C-PERF-04 only typed positive process-group identities retain exclusion: %s", (value) => {
  const error =
    typeof value === "number" || typeof value === "string"
      ? elwoodError("claude_update_failed", "failed", { cleanupProcessGroup: value })
      : value;
  expect(unresolvedProbeGroup(error)).toBeUndefined();
});

test("C-PERF-04 contender wait expires without evicting the active owner", async () => {
  const root = tempDir("elwood-update-wait-");
  let release!: () => void;
  const owner = coordinatedAutoupdate(
    "codex",
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    { root },
  );
  await expect.poll(() => typeof release).toBe("function");
  const path = updateLockPath("codex", root);
  const before = await readFile(join(path, "owner"), "utf8");
  const update = vi.fn(() => Promise.resolve());
  await expect(
    coordinatedAutoupdate("codex", update, { root, waitMs: 10, pollMs: 1 }),
  ).rejects.toMatchObject({ code: "codex_update_failed" });
  expect(update).not.toHaveBeenCalled();
  expect(await readFile(join(path, "owner"), "utf8")).toBe(before);
  release();
  await owner;
});

test("C-PERF-04 expired registration removes its temporary record without replacing its owner", async () => {
  const root = tempDir("elwood-expired-registration-");
  await writeFile(join(root, "owner"), "123:abc");
  const controller = new AbortController();
  controller.abort();
  await retainProbeOwner(root, { pid: 123, token: "abc" }, 456, controller.signal);
  expect(await readFile(join(root, "owner"), "utf8")).toBe("123:abc");
  await expect(readFile(join(root, "owner.next"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    retainProbeOwner(join(root, "missing"), { pid: 123, token: "abc" }, 456),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
