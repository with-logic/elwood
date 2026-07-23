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
  removeSessionFiles,
  sessionDir,
  writeSessionRecord,
} from "../../src/state/store.ts";

// `rmSync` throws a bare STRING (non-Error) only for the raw-remove teardown dir, so
// the store's `String(error)` normalization branch is exercised without disturbing
// any other filesystem write (mocks are hoisted above imports by vitest).
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    rmSync: (path: string, options?: Parameters<typeof actual.rmSync>[1]) => {
      if (typeof path === "string" && path.includes("raw-remove"))
        throwPrimitive("raw remove failure");
      if (typeof path === "string" && path.includes("err-remove"))
        throw new Error("EPERM remove failure");
      return actual.rmSync(path, options);
    },
  };
});

describe("state store edges", () => {
  test("C-ERR-04 stringifies non-Error read failures as corrupt-state causes", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-validate-"));
    const record = createSessionRecord({ cwd: root, id: "raw-read" });
    writeSessionRecord(record, sessionDir(root, "raw-read"));
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
    const record = createSessionRecord({ cwd: root, id: "raw-remove" });
    const dir = sessionDir(root, "raw-remove");
    writeSessionRecord(record, dir);
    let caught: unknown;
    try {
      removeSessionFiles({
        stateDir: root,
        elwoodSessionId: "raw-remove",
        socketPath: "/tmp/x.sock",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "teardown_failed",
      details: { cause: "raw remove failure", sessionDir: dir },
    });
  });

  test("C-STATE-08 surfaces an Error failure's message while removing session files", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-validate-"));
    const record = createSessionRecord({ cwd: root, id: "err-remove" });
    const dir = sessionDir(root, "err-remove");
    writeSessionRecord(record, dir);
    let caught: unknown;
    try {
      removeSessionFiles({
        stateDir: root,
        elwoodSessionId: "err-remove",
        socketPath: "/tmp/x.sock",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "teardown_failed",
      details: { cause: "EPERM remove failure", sessionDir: dir },
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
