/** Real macOS VolFS lookup retains a renamed original directory (PRD §8.1, C-STATE-01). */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { PublicationDirectoryHold } from "../../src/state/publication-directory.ts";
import { tempDir } from "../helpers/tmp.ts";

test.runIf(process.platform === "darwin")(
  "C-STATE-01 the real held inode address reads the original after rename and replacement",
  () => {
    const root = tempDir();
    const parent = join(root, "workspace");
    const moved = join(root, "moved");
    const file = join(parent, "session.json");
    mkdirSync(parent);
    writeFileSync(file, "original");
    const hold = new PublicationDirectoryHold(file);
    try {
      renameSync(parent, moved);
      mkdirSync(parent);
      writeFileSync(file, "replacement");
      const heldFile = hold.pathInHeldDirectory(file);
      expect(heldFile).toMatch(/^\/\.vol\/\d+\/\d+\/session\.json$/);
      expect(readFileSync(heldFile, "utf8")).toBe("original");
      expect(readFileSync(file, "utf8")).toBe("replacement");
    } finally {
      hold.close();
    }
  },
);
