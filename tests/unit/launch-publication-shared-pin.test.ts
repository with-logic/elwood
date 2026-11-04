/** Files in one startup share one live directory hold (PRD §8.1, C-API-61). */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { reserveLaunchOwnership } from "../../src/state/launch-ownership.ts";
import { LaunchPublication } from "../../src/state/launch-publication.ts";
import { PublicationDirectoryHold } from "../../src/state/publication-directory.ts";
import { tempDir } from "../helpers/tmp.ts";

const parentOpens = vi.hoisted(() => ({ parent: "", total: 0, live: new Set<number>() }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      if (
        parentOpens.parent !== "" &&
        typeof args[1] === "number" &&
        (args[1] & actual.constants.O_DIRECTORY) !== 0
      ) {
        const opened = actual.fstatSync(fd);
        const parent = actual.statSync(parentOpens.parent);
        if (opened.dev === parent.dev && opened.ino === parent.ino) {
          parentOpens.total += 1;
          parentOpens.live.add(fd);
        }
      }
      return fd;
    },
    closeSync: (fd: number) => {
      actual.closeSync(fd);
      parentOpens.live.delete(fd);
    },
  };
});
afterEach(() => {
  parentOpens.parent = "";
  parentOpens.total = 0;
  parentOpens.live.clear();
  vi.restoreAllMocks();
});

test("C-API-61 sibling publications keep their parent pinned until the last file settles", () => {
  const root = tempDir();
  const file = join(root, "session.json");
  const settings = join(root, "settings.json");
  const close = vi.spyOn(PublicationDirectoryHold.prototype, "close");
  const publication = new LaunchPublication();
  parentOpens.parent = root;
  const directory = publication.write(file, "record");
  publication.write(settings, "settings");
  // One held pin plus the two atomic writes' temporary directory validations.
  expect(parentOpens.total).toBe(3);
  expect(parentOpens.live.size).toBe(1);
  publication.forgetMatching(file, directory);
  expect(close).not.toHaveBeenCalled();
  publication.rollback();
  expect(close).toHaveBeenCalledTimes(1);
  expect(parentOpens.live.size).toBe(0);
  expect(readFileSync(file, "utf8")).toBe("record");
  expect(existsSync(settings)).toBe(false);
});

test("C-API-61 successful commit releases its shared hold and keeps published files", () => {
  const root = tempDir();
  const file = join(root, "session.json");
  parentOpens.parent = root;
  const owner = reserveLaunchOwnership(root);
  try {
    owner.publishFile(file, "record");
    owner.publishFile(join(root, "settings.json"), "settings");
    expect(parentOpens.live.size).toBe(1);
    owner.commit();
    expect(parentOpens.live.size).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("record");
  } finally {
    owner.release();
  }
});

test("C-API-20 successor commit releases its own and failed predecessor holds", () => {
  const root = tempDir();
  const file = join(root, "session.json");
  parentOpens.parent = root;
  const a = reserveLaunchOwnership(root);
  a.publishFile(file, "A");
  a.commit();
  const b = reserveLaunchOwnership(root);
  b.publishFile(file, "B");
  const c = reserveLaunchOwnership(root);
  c.publishFile(file, "C");
  try {
    expect(parentOpens.live.size).toBe(2);
    b.rollback();
    expect(parentOpens.live.size).toBe(2);
    c.commit();
    expect(parentOpens.live.size).toBe(0);
    expect(b.canPersist()).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("C");
  } finally {
    c.release();
    b.release();
    a.release();
  }
});
