/**
 * Unit coverage for state store file-operation edge cases.
 * Covers PRD §10, C-ERR-04, C-STATE-03, and C-STATE-08.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { fsyncDir } from "../../src/state/files.ts";
import {
  createSessionRecord,
  readSessionRecord,
  removeSessionDir,
  writeSessionRecord,
} from "../../src/state/store.ts";

describe("state store edges", () => {
  test("C-ERR-04 stringifies non-Error read failures as corrupt-state causes", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-validate-"));
    const record = createSessionRecord({ stateDir: root, cwd: root, id: "raw-read" });
    writeSessionRecord(record);
    const spy = vi
      .spyOn(JSON, "parse")
      .mockImplementationOnce(() => throwPrimitive("raw parse failure"));
    let caught: unknown;
    try {
      readSessionRecord(root, "raw-read");
    } catch (error) {
      caught = error;
    }
    spy.mockRestore();
    expect(caught).toMatchObject({
      code: "state_corrupt",
      details: { cause: "raw parse failure" },
    });
  });

  test("C-STATE-08 stringifies non-Error failures while removing session files", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-validate-"));
    const record = createSessionRecord({ stateDir: root, cwd: root, id: "raw-remove" });
    let first = true;
    const throwing = {
      ...record,
      paths: {
        ...record.paths,
        get sessionDir(): string {
          if (first) {
            first = false;
            throwPrimitive("raw remove failure");
          }
          return record.paths.sessionDir;
        },
      },
    };
    let caught: unknown;
    try {
      removeSessionDir(throwing);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "teardown_failed",
      details: { cause: "raw remove failure", sessionDir: record.paths.sessionDir },
    });
  });

  test("C-STATE-03 fsyncDir ignores missing directories", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-validate-"));
    expect(() => fsyncDir(join(root, "missing"))).not.toThrow();
  });
});

function throwPrimitive(value: string): never {
  throw value; // a bare string exercises non-Error failure normalization
}
