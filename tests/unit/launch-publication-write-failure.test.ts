/** Failed atomic publication retains both pre-rename and post-rename ownership (C-API-20). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { writePrivateFileAtomic } from "../../src/state/files.ts";
import { LaunchPublication } from "../../src/state/launch-publication.ts";
import { tempDir } from "../helpers/tmp.ts";

const failure = vi.hoisted(() => ({ at: "" }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (failure.at === "rename") throw new Error("rename failed");
      actual.renameSync(from, to);
    },
    fsyncSync: (fd: number) => {
      if (failure.at === "directory fsync" && actual.fstatSync(fd).isDirectory())
        throw new Error("directory fsync failed");
      actual.fsyncSync(fd);
    },
  };
});
afterEach(() => {
  failure.at = "";
});

for (const at of ["rename", "directory fsync"]) {
  test(`C-API-20 a second publication failing at ${at} restores the predecessor`, () => {
    const file = join(tempDir(), "record");
    writePrivateFileAtomic(file, "predecessor");
    const publication = new LaunchPublication();
    publication.write(file, "A");
    failure.at = at;
    expect(() => publication.write(file, "B")).toThrow(`${at} failed`);
    failure.at = "";
    expect(readFileSync(file, "utf8")).toBe(at === "rename" ? "A" : "B");
    publication.rollback();
    expect(readFileSync(file, "utf8")).toBe("predecessor");
  });
}
