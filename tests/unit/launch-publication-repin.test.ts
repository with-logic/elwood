/** Publication versions and validation stay with one physical directory (C-API-61). */
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { writePrivateFileAtomic } from "../../src/state/files.ts";
import { LaunchPublication } from "../../src/state/launch-publication.ts";
import { tempDir } from "../helpers/tmp.ts";

const race = vi.hoisted(() => ({ parent: "", original: "", replacement: "", armed: false }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    closeSync: (fd: number) => {
      const held = actual.fstatSync(fd);
      const swap =
        race.armed && held.isDirectory() && held.ino === actual.statSync(race.parent).ino;
      actual.closeSync(fd);
      if (swap) {
        race.armed = false;
        actual.renameSync(race.parent, race.original);
        actual.renameSync(race.replacement, race.parent);
      }
    },
  };
});
afterEach(() => {
  race.armed = false;
});

describe.runIf(process.platform === "darwin")("pinned publication boundaries", () => {
  test("C-API-61 substituting another owned tree after validation cannot overwrite its record", () => {
    const root = tempDir();
    race.parent = join(root, "workspace");
    race.original = join(root, "original");
    race.replacement = join(root, "other-workspace");
    mkdirSync(race.parent, { mode: 0o700 });
    mkdirSync(race.replacement, { mode: 0o700 });
    const file = join(race.parent, "session.json");
    writePrivateFileAtomic(file, "original posture");
    writePrivateFileAtomic(join(race.replacement, "session.json"), "other posture");
    const publication = new LaunchPublication();
    race.armed = true;
    try {
      publication.write(file, "attempted posture");
      expect(readFileSync(join(race.original, "session.json"), "utf8")).toBe("attempted posture");
      expect(readFileSync(file, "utf8")).toBe("other posture");
    } finally {
      race.armed = false;
      publication.rollback();
    }
    expect(readFileSync(join(race.original, "session.json"), "utf8")).toBe("original posture");
    expect(readFileSync(file, "utf8")).toBe("other posture");
  });

  test.each([
    undefined,
    "prior posture",
  ])("C-API-61 a later write after rename cannot discard its rollback versions (%s)", (before) => {
    const root = tempDir();
    const parent = join(root, "workspace");
    const moved = join(root, "moved");
    mkdirSync(parent);
    const file = join(parent, "session.json");
    if (before !== undefined) writePrivateFileAtomic(file, before);
    const publication = new LaunchPublication();
    publication.write(file, "pending posture");
    renameSync(parent, moved);
    try {
      publication.write(file, "hook resume id");
    } catch {
      /* A rejected later write must retain the earlier rollback versions. */
    }
    publication.rollback();
    const physical = join(moved, "session.json");
    if (before === undefined) expect(existsSync(physical)).toBe(false);
    else expect(readFileSync(physical, "utf8")).toBe(before);
  });
});
