/**
 * Secure CLI resume-state coverage (PRD §12A.5, C-CLI-15/C-CLI-16).
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  readPrivateSessionRecord,
  removeSessionIdentity,
} from "../../src/state/private-session.ts";
import {
  createSessionRecord,
  prepareStateDir,
  sessionDir,
  writeSessionRecord,
} from "../../src/state/store.ts";

function fixture(id = "saved") {
  const root = mkdtempSync(join(tmpdir(), "elwood-private-state-"));
  const stateDir = join(root, "state");
  prepareStateDir(stateDir);
  const record = createSessionRecord({ cwd: root, id, adapter: "codex" });
  const dir = sessionDir(stateDir, id);
  writeSessionRecord(record, dir);
  return { root, stateDir, record, dir, path: join(dir, "session.json") };
}

describe("private CLI session state", () => {
  test("C-CLI-15 reads a private owner-matched regular record", () => {
    const saved = fixture();
    expect(readPrivateSessionRecord(saved.stateDir, "saved")).toEqual(saved.record);
  });

  test("C-CLI-15 distinguishes absent state from unsafe or corrupt state", () => {
    const missing = fixture();
    expect(() => readPrivateSessionRecord(missing.stateDir, "absent")).toThrow(/No Elwood/iu);
    expect(() => readPrivateSessionRecord(missing.stateDir, "../escape")).toThrow(/Invalid/iu);

    const sharedRoot = fixture("shared-root");
    chmodSync(sharedRoot.stateDir, 0o755);
    expect(() => readPrivateSessionRecord(sharedRoot.stateDir, "shared-root")).toThrow(/private/iu);

    const sharedSessions = fixture("shared-sessions");
    chmodSync(join(sharedSessions.stateDir, "sessions"), 0o755);
    expect(() => readPrivateSessionRecord(sharedSessions.stateDir, "shared-sessions")).toThrow(
      /private/iu,
    );

    const sharedDir = fixture("shared-dir");
    chmodSync(sharedDir.dir, 0o755);
    expect(() => readPrivateSessionRecord(sharedDir.stateDir, "shared-dir")).toThrow(/private/iu);
  });

  test("C-CLI-15 rejects linked, non-regular, shared, wrong-owner, and invalid records", () => {
    const linkedRoot = fixture("linked-root");
    const alias = join(linkedRoot.root, "alias");
    symlinkSync(linkedRoot.stateDir, alias);
    expect(() => readPrivateSessionRecord(alias, "linked-root")).toThrow(/private/iu);

    const linkedFile = fixture("linked-file");
    const target = join(linkedFile.root, "target.json");
    unlinkSync(linkedFile.path);
    symlinkSync(target, linkedFile.path);
    expect(() => readPrivateSessionRecord(linkedFile.stateDir, "linked-file")).toThrow(/private/iu);

    const directory = fixture("directory");
    unlinkSync(directory.path);
    mkdirSync(directory.path, { mode: 0o700 });
    expect(() => readPrivateSessionRecord(directory.stateDir, "directory")).toThrow(/private/iu);

    const shared = fixture("shared-file");
    chmodSync(shared.path, 0o644);
    expect(() => readPrivateSessionRecord(shared.stateDir, "shared-file")).toThrow(/private/iu);

    const owner = fixture("wrong-owner");
    expect(() =>
      readPrivateSessionRecord(owner.stateDir, "wrong-owner", {
        uid: owner.record.schemaVersion + process.getuid!(),
      }),
    ).toThrow(/private/iu);

    const corrupt = fixture("corrupt");
    unlinkSync(corrupt.path);
    symlinkSync(join(corrupt.root, "missing"), corrupt.path);
    expect(() => readPrivateSessionRecord(corrupt.stateDir, "corrupt")).toThrow(/private/iu);

    const malformed = fixture("malformed");
    writeFileSync(malformed.path, "{}", { mode: 0o600 });
    expect(() => readPrivateSessionRecord(malformed.stateDir, "malformed")).toThrow(/valid/iu);
  });

  test("C-CLI-08 removes record state when no live facade owns teardown", () => {
    const saved = fixture("remove");
    removeSessionIdentity(saved.stateDir, "remove", "codex");
    expect(existsSync(saved.dir)).toBe(false);
  });
});
