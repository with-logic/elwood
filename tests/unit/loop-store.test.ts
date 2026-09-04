/**
 * Integration coverage for private recurring-loop sidecar persistence.
 * Covers PRD §8.2 and C-LOOP-11/C-LOOP-13/C-LOOP-21.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { ElwoodError } from "../../src/core/errors.ts";
import { LOOP_EXPIRATION_MS } from "../../src/core/loops/constants.ts";
import {
  clearLoopDefinitions,
  pruneExpiredLoopDefinitions,
  readLoopDefinitions,
  writeLoopDefinitions,
} from "../../src/state/loop-store.ts";
import {
  createSessionRecord,
  prepareStateDir,
  readSessionRecord,
  sessionDir,
  writeSessionRecord,
} from "../../src/state/store.ts";

const createdAt = 1_800_000_000_000;
const definitions = [
  {
    id: "fixed",
    message: "check the deployment",
    mode: "fixed" as const,
    intervalMs: 60_000,
    jitterMs: 6_000,
    createdAt,
    expiresAt: createdAt + LOOP_EXPIRATION_MS,
  },
  {
    id: "idle",
    message: "check when idle",
    mode: "idle" as const,
    jitterMs: 30_000,
    createdAt: createdAt + 1,
    expiresAt: createdAt + 1 + LOOP_EXPIRATION_MS,
  },
];

describe("loop sidecar store", () => {
  test("C-LOOP-21 an absent sidecar is empty and leaves schema-v1 records unchanged", () => {
    const root = stateRoot();
    for (const adapter of ["claude", "codex"] as const) {
      const id = `absent-${adapter}`;
      const record = createSessionRecord({ cwd: root, id, adapter });
      writeSessionRecord(record, sessionDir(root, id));
      expect(readLoopDefinitions(root, id)).toEqual([]);
      expect(readSessionRecord(root, id)).toEqual(record);
    }
  });

  test("C-LOOP-11 round-trips only canonical definition fields in a private atomic sidecar", () => {
    const root = stateRoot();
    const id = "round-trip";
    const withExtra = definitions.map((definition) => ({ ...definition, state: "due" }));
    writeLoopDefinitions(root, id, withExtra);
    expect(readLoopDefinitions(root, id)).toEqual(definitions);
    const path = join(sessionDir(root, id), "loops.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).not.toContain('"state"');
    expect(readFileSync(path, "utf8")).not.toContain("nextDueAt");
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8")).loops[0]).sort()).toEqual([
      "createdAt",
      "expiresAt",
      "id",
      "intervalMs",
      "jitterMs",
      "message",
      "mode",
    ]);
    expect(existsSync(`${path}.tmp-${process.pid}`)).toBe(false);
  });

  test("C-LOOP-13 prunes at the expiry boundary and clear durably removes all definitions", () => {
    const root = stateRoot();
    const id = "prune-clear";
    expect(pruneExpiredLoopDefinitions(definitions, definitions[0]!.expiresAt)).toEqual([
      definitions[1],
    ]);
    writeLoopDefinitions(root, id, definitions);
    clearLoopDefinitions(root, id);
    expect(readLoopDefinitions(root, id)).toEqual([]);
  });

  test("C-LOOP-21 rejects malformed, permissive, and unexpectedly owned sidecars", () => {
    const root = stateRoot();
    const malformed = "malformed";
    writeLoopDefinitions(root, malformed, definitions);
    const malformedPath = join(sessionDir(root, malformed), "loops.json");
    writeFileSync(malformedPath, `{"schemaVersion":1,"loops":[`);
    expect(code(() => readLoopDefinitions(root, malformed))).toBe("state_corrupt");

    const permissive = "permissive";
    writeLoopDefinitions(root, permissive, definitions);
    chmodSync(join(sessionDir(root, permissive), "loops.json"), 0o640);
    expect(code(() => readLoopDefinitions(root, permissive))).toBe("state_corrupt");

    const foreign = "foreign";
    writeLoopDefinitions(root, foreign, definitions);
    const uid = statSync(join(sessionDir(root, foreign), "loops.json")).uid;
    const spy = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    expect(code(() => readLoopDefinitions(root, foreign))).toBe("state_corrupt");
    spy.mockRestore();

    expect(code(() => readLoopDefinitions(root, "x".repeat(300)))).toBe("state_corrupt");
  });

  test("C-LOOP-21 rejects structurally invalid files, non-files, and unverifiable owners", () => {
    const root = stateRoot();
    const invalid = "invalid-schema";
    writeLoopDefinitions(root, invalid, definitions);
    writeFileSync(join(sessionDir(root, invalid), "loops.json"), '{"schemaVersion":2,"loops":[]}');
    expect(code(() => readLoopDefinitions(root, invalid))).toBe("state_corrupt");

    const directory = "directory-sidecar";
    mkdirSync(join(sessionDir(root, directory), "loops.json"), { recursive: true });
    expect(code(() => readLoopDefinitions(root, directory))).toBe("state_corrupt");

    const unknownOwner = "unknown-owner";
    writeLoopDefinitions(root, unknownOwner, definitions);
    const spy = vi.spyOn(process, "getuid").mockImplementation(() => undefined as never);
    expect(code(() => readLoopDefinitions(root, unknownOwner))).toBe("state_corrupt");
    spy.mockRestore();
  });

  test("C-LOOP-11 rejects invalid write inputs before touching durable state", () => {
    const root = stateRoot();
    const invalid = [{ ...definitions[0]!, intervalMs: 1 }];
    expect(() => writeLoopDefinitions(root, "invalid-write", invalid)).toThrow(TypeError);
    expect(readLoopDefinitions(root, "invalid-write")).toEqual([]);
  });

  test("C-LOOP-21 corruption errors never expose stored prompt text", () => {
    const root = stateRoot();
    const id = "redacted-error";
    writeLoopDefinitions(root, id, definitions);
    chmodSync(join(sessionDir(root, id), "loops.json"), 0o644);
    try {
      readLoopDefinitions(root, id);
    } catch (error) {
      expect(error).toBeInstanceOf(ElwoodError);
      expect(JSON.stringify(error)).not.toContain(definitions[0]!.message);
      return;
    }
    throw new Error("Expected corrupt state");
  });
});

function stateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "elwood-loop-state-"));
  prepareStateDir(root);
  return root;
}

function code(callback: () => unknown): string {
  try {
    callback();
  } catch (error) {
    if (error instanceof ElwoodError) return error.code;
    throw error;
  }
  throw new Error("Expected ElwoodError");
}
