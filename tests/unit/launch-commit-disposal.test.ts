/** Read-only pin disposal cannot reject publication commit (PRD §8.1, C-API-61). */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test, vi } from "vitest";
import { reserveLaunchOwnership } from "../../src/state/launch-ownership.ts";
import { tempDir } from "../helpers/tmp.ts";

const fault = vi.hoisted(() => ({ dispose: false }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    closeSync: (fd: number) => {
      actual.closeSync(fd);
      if (fault.dispose) throw new Error("released then failed");
    },
  };
});

test("C-API-61 a commit completes after its read-only pin close reports failure", () => {
  const file = join(tempDir(), "session.json");
  const predecessor = reserveLaunchOwnership(dirname(file));
  predecessor.publishFile(file, "prior posture");
  predecessor.commit();
  const resumed = reserveLaunchOwnership(dirname(file));
  resumed.publishFile(file, "requested posture");
  try {
    fault.dispose = true;
    expect(() => resumed.commit()).not.toThrow();
    fault.dispose = false;
    expect(readFileSync(file, "utf8")).toBe("requested posture");
    expect(predecessor.canPersist()).toBe(false);
    resumed.persistFile(file, "active state");
    expect(readFileSync(file, "utf8")).toBe("active state");
  } finally {
    fault.dispose = false;
    resumed.release();
    predecessor.release();
  }
});
