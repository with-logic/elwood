/** Failed startup restores only its own file versions (PRD §8.1, C-API-20). */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { writePrivateFileAtomic } from "../../src/state/files.ts";
import { LaunchPublication } from "../../src/state/launch-publication.ts";
import { tempDir } from "../helpers/tmp.ts";

test("C-API-20 rollback restores initial bytes and removes newly published files", () => {
  const root = tempDir();
  const old = join(root, "old");
  const fresh = join(root, "new");
  writePrivateFileAtomic(old, "before");
  const publication = new LaunchPublication();
  publication.write(old, "first");
  publication.write(old, "second");
  publication.write(fresh, "new");
  publication.rollback();
  expect(readFileSync(old, "utf8")).toBe("before");
  expect(existsSync(fresh)).toBe(false);
});

test("C-API-20 an intervening predecessor write becomes the next rollback baseline", () => {
  const file = join(tempDir(), "record");
  writePrivateFileAtomic(file, "original");
  const publication = new LaunchPublication();
  publication.write(file, "A");
  writePrivateFileAtomic(file, "B");
  publication.write(file, "C");
  publication.rollback();
  expect(readFileSync(file, "utf8")).toBe("B");
});

test("C-API-20 rollback preserves a newer externally published version", () => {
  const file = join(tempDir(), "record");
  const publication = new LaunchPublication();
  publication.write(file, "pending");
  writePrivateFileAtomic(file, "newer");
  publication.rollback();
  expect(readFileSync(file, "utf8")).toBe("newer");
});

test("C-API-20 invalid publication and failed rollback are explicit state errors", () => {
  const file = join(tempDir(), "record");
  mkdirSync(file);
  const publication = new LaunchPublication();
  expect(() => publication.write(file, "pending")).toThrowError(
    expect.objectContaining({ code: "state_corrupt" }),
  );
  rmSync(file, { recursive: true });
  publication.write(file, "pending");
  rmSync(file);
  mkdirSync(file);
  expect(() => publication.rollback()).toThrowError(
    expect.objectContaining({ code: "state_corrupt" }),
  );
});
