/** Files in one startup share one live directory hold (PRD §8.1, C-API-61). */
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { LaunchPublication } from "../../src/state/launch-publication.ts";
import { PublicationDirectory } from "../../src/state/publication-directory.ts";
import { tempDir } from "../helpers/tmp.ts";

afterEach(() => vi.restoreAllMocks());

test("C-API-61 sibling publications keep their parent pinned until the last file settles", () => {
  const root = tempDir();
  const file = join(root, "session.json");
  const settings = join(root, "settings.json");
  const close = vi.spyOn(PublicationDirectory.prototype, "close");
  const publication = new LaunchPublication();
  publication.write(file, "record");
  publication.write(settings, "settings");
  publication.forget(file);
  expect(close).not.toHaveBeenCalled();
  publication.rollback();
  expect(close).toHaveBeenCalledTimes(1);
  expect(readFileSync(file, "utf8")).toBe("record");
  expect(existsSync(settings)).toBe(false);
});

test.runIf(process.platform === "darwin")(
  "C-API-61 a new file after rename uses its already-held parent",
  () => {
    const root = tempDir();
    const parent = join(root, "workspace");
    const moved = join(root, "moved");
    mkdirSync(parent);
    const publication = new LaunchPublication();
    publication.write(join(parent, "session.json"), "record");
    renameSync(parent, moved);
    publication.write(join(parent, "settings.json"), "settings");
    publication.rollback();
    expect(existsSync(join(moved, "session.json"))).toBe(false);
    expect(existsSync(join(moved, "settings.json"))).toBe(false);
  },
);
