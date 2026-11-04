/** Publication rejects replaceable custom-state ancestry before I/O (PRD §8.1, C-STATE-01). */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import { writePrivateFileAtomic } from "../../src/state/files.ts";
import { LaunchPublication } from "../../src/state/launch-publication.ts";
import { assertTrustedPublicationParent } from "../../src/state/publication-parent-trust.ts";

function fixture(mode: number) {
  // /tmp resolves to /private/tmp on macOS, outside its private per-user TMPDIR.
  const root = mkdtempSync(join(realpathSync("/tmp"), "elwood-publication-parent-"));
  onTestFinished(() => {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  });
  const workspace = join(root, "workspace");
  const session = join(workspace, "session");
  mkdirSync(workspace, { mode: 0o755 });
  mkdirSync(session, { mode: 0o700 });
  chmodSync(root, mode);
  return { root, session, file: join(session, "session.json") };
}

describe("custom publication ancestry", () => {
  test("C-STATE-01 refuses a non-sticky world-writable ancestor", () => {
    const { file } = fixture(0o777);
    writePrivateFileAtomic(file, "prior posture");
    const publication = new LaunchPublication();
    expect(() => publication.write(file, "attempted posture")).toThrowError(
      expect.objectContaining({
        code: "state_corrupt",
        message: "Cannot trust launch state parent.",
      }),
    );
    expect(readFileSync(file, "utf8")).toBe("prior posture");
    publication.rollback();
    expect(readFileSync(file, "utf8")).toBe("prior posture");
  });

  test.each([0o700, 0o1777])("C-STATE-01 permits private or sticky ancestry (%o)", (mode) => {
    const { file } = fixture(mode);
    writePrivateFileAtomic(file, "prior posture");
    const publication = new LaunchPublication();
    publication.write(file, "attempted posture");
    expect(readFileSync(file, "utf8")).toBe("attempted posture");
    publication.rollback();
    expect(readFileSync(file, "utf8")).toBe("prior posture");
  });

  test.skipIf(process.getuid!() === 0)(
    "C-STATE-01 preserves a native ancestor inspection error",
    () => {
      const { root, file } = fixture(0o700);
      writePrivateFileAtomic(file, "prior posture");
      const workspace = join(root, "workspace");
      chmodSync(workspace, 0o000);
      try {
        expect(() => assertTrustedPublicationParent(file)).toThrowError(
          expect.objectContaining({ code: "EACCES" }),
        );
      } finally {
        chmodSync(workspace, 0o755);
      }
      expect(readFileSync(file, "utf8")).toBe("prior posture");
    },
  );

  test("C-STATE-01 missing publication parents preserve creation and raw ENOENT behavior", () => {
    const { session } = fixture(0o700);
    const created = join(session, "new-parent", "record");
    const publication = new LaunchPublication();
    publication.write(created, "fresh record");
    expect(readFileSync(created, "utf8")).toBe("fresh record");
    publication.rollback();
    expect(existsSync(created)).toBe(false);
    const absent = join(session, "missing", "parent", "record");
    expect(() => publication.write(absent, "must fail")).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });
});
