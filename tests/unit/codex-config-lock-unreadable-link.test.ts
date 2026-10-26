/**
 * A missing Codex config whose symlink cannot be read rejects without running the locked task:
 * only a path that does not exist falls back to where the config will be (PRD §5.3 setModel
 * restore, C-CODEX-14). The test volume reads links, so `node:fs` simulates the failure.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { withCodexConfigLock } from "../../src/codex/config/lock.ts";
import { tempDir } from "../helpers/tmp.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readlinkSync = (
    path: Parameters<typeof actual.readlinkSync>[0],
    options?: Parameters<typeof actual.readlinkSync>[1],
  ) => {
    if (String(path).includes("/unreadable-link/"))
      throw Object.assign(new Error("EIO: i/o error, readlink"), { code: "EIO" });
    return actual.readlinkSync(path, options);
  };
  return { ...actual, readlinkSync };
});

test("C-CODEX-14 a missing config whose symlink cannot be read rejects without running", async () => {
  const dir = join(tempDir(), "unreadable-link");
  mkdirSync(dir);
  const path = join(dir, "config.toml");
  const task = vi.fn(() => Promise.resolve());
  await expect(withCodexConfigLock(path, task)).rejects.toMatchObject({
    code: "model_automation_failed",
    details: { path, errno: "EIO" },
  });
  expect(task).not.toHaveBeenCalled();
});
