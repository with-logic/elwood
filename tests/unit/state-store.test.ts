/**
 * Focused unit coverage for Elwood session state helpers.
 * Covers PRD §8 and §10: the minimal persisted record round-trips only the six kept
 * fields, and derived files are removed via (stateDir, id, socketPath).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { ElwoodError } from "../../src/core/errors.ts";
import { writePrivateFile, writePrivateFileAtomic } from "../../src/state/files.ts";
import {
  createSessionRecord,
  defaultStateDir,
  prepareStateDir,
  readSessionRecord,
  removeSessionFiles,
  sessionDir,
  writeSessionRecord,
} from "../../src/state/store.ts";

describe("state store", () => {
  test("C-ERR-03 C-ERR-04 state error paths are typed", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-state-"));
    expect(defaultStateDir(root)).toBe(join(root, ".elwood"));
    expect(sessionDir(root, "missing")).toBe(join(root, "sessions", "missing"));
    expect(sessionDir("relative-state", "missing")).toBe(
      join(resolve("relative-state"), "sessions", "missing"),
    );
    expect(elwoodCode(() => sessionDir(root, "../escape"))).toBe("state_not_found");
    expect(elwoodCode(() => readSessionRecord(root, "missing"))).toBe("state_not_found");
    const dir = sessionDir(root, "bad");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.json"), '{"schemaVersion":2,"elwoodSessionId":"bad"}');
    expect(elwoodCode(() => readSessionRecord(root, "bad"))).toBe("state_corrupt");
    const corruptDir = sessionDir(root, "corrupt");
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(join(corruptDir, "session.json"), "{");
    expect(elwoodCode(() => readSessionRecord(root, "corrupt"))).toBe("state_corrupt");
    expect(elwoodCode(() => removeSessionFiles(root, "\0bad", "/tmp/x.sock"))).toBe(
      "state_not_found",
    );
  });

  test("C-STATE the minimal record round-trips only the six kept fields", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-state-"));
    prepareStateDir(root);
    const record = createSessionRecord({ cwd: root, id: "minimal", adapter: "codex" });
    const dir = sessionDir(root, "minimal");
    writeSessionRecord(record, dir);
    const roundTripped = readSessionRecord(root, "minimal");
    expect(roundTripped).toEqual({
      schemaVersion: 1,
      elwoodSessionId: "minimal",
      adapter: "codex",
      cwd: resolve(root),
      claude: {},
      codex: {},
    });
    // No cut fields leak into the persisted JSON.
    const raw = readFileSync(join(dir, "session.json"), "utf8");
    for (const cut of [
      "metadata",
      "warnings",
      "createdAt",
      "updatedAt",
      "status",
      "paths",
      "bridgeToken",
      "terminalSize",
    ]) {
      expect(raw).not.toContain(`"${cut}"`);
    }
  });

  test("C-STATE-08 removeSessionFiles removes the derived dir and the socket home", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-state-"));
    prepareStateDir(root);
    const record = createSessionRecord({ cwd: root, id: "teardown" });
    const dir = sessionDir(root, "teardown");
    writeSessionRecord(record, dir);
    // A fresh mkdtemp socket home (elwood-prefixed) is removed alongside the dir.
    const socketHome = mkdtempSync(join(tmpdir(), "elwood-"));
    const socketPath = join(socketHome, "h.sock");
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(socketHome)).toBe(true);
    removeSessionFiles(root, "teardown", socketPath);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(socketHome)).toBe(false);
    // A non-elwood socket home is left untouched (only the derived dir is removed).
    const foreignHome = mkdtempSync(join(tmpdir(), "other-"));
    const record2 = createSessionRecord({ cwd: root, id: "teardown-2" });
    const dir2 = sessionDir(root, "teardown-2");
    writeSessionRecord(record2, dir2);
    removeSessionFiles(root, "teardown-2", join(foreignHome, "h.sock"));
    expect(existsSync(dir2)).toBe(false);
    expect(existsSync(foreignHome)).toBe(true);
  });

  test("C-STATE-03 C-STATE-11 custom state directories do not receive or overwrite gitignore files", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-state-"));
    const projectState = join(root, ".elwood");
    prepareStateDir(projectState, { gitignore: true });
    expect(readFileSync(join(projectState, ".gitignore"), "utf8")).toBe("*\n");
    expect(statSync(projectState).mode & 0o777).toBe(0o755);
    expect(statSync(join(projectState, ".gitignore")).mode & 0o777).toBe(0o644);
    const record = createSessionRecord({ cwd: root, id: "atomic" });
    const dir = sessionDir(projectState, "atomic");
    writeSessionRecord(record, dir);
    expect(readFileSync(join(dir, "session.json"), "utf8")).toContain(record.elwoodSessionId);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "session.json")).mode & 0o777).toBe(0o600);
    writeFileSync(join(projectState, ".gitignore"), "!keep\n");
    prepareStateDir(projectState, { gitignore: true });
    expect(readFileSync(join(projectState, ".gitignore"), "utf8")).toBe("!keep\n");
    const customState = join(root, "custom-state");
    prepareStateDir(customState);
    expect(existsSync(join(customState, ".gitignore"))).toBe(false);
  });

  test("C-STATE-03 atomic private writes fully replace files and clean temp files", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-state-"));
    const privatePath = join(root, "private", "settings.json");
    writePrivateFile(privatePath, "{}");
    expect(statSync(privatePath).mode & 0o777).toBe(0o600);
    const path = join(root, "session.json");
    writePrivateFileAtomic(path, "first");
    writePrivateFileAtomic(path, "second");
    expect(readFileSync(path, "utf8")).toBe("second");
    expect(readdirSync(root).filter((entry) => entry.includes(".tmp-"))).toEqual([]);
  });
});

function elwoodCode(callback: () => unknown): string {
  try {
    callback();
  } catch (error) {
    if (error instanceof ElwoodError) return error.code;
    throw error;
  }
  throw new Error("Expected ElwoodError");
}
