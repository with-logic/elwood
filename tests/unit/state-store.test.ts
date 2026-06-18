/**
 * Focused unit coverage for Elwood session state helpers.
 * Covers PRD §8 and §10.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ElwoodError } from "../../src/core/errors.ts";
import {
  createSessionRecord,
  defaultStateDir,
  prepareStateDir,
  readSessionRecord,
  removeSessionDir,
  sessionDir,
  upsertSessionWarning,
  writeSessionRecord,
} from "../../src/state/store.ts";

describe("state store", () => {
  test("C-ERR-03 C-ERR-04 C-STATE error paths are typed", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-state-"));
    expect(defaultStateDir(root)).toBe(join(root, ".elwood"));
    expect(sessionDir(root, "missing")).toBe(join(root, "sessions", "missing"));
    expect(sessionDir("relative-state", "missing")).toBe(
      join(resolve("relative-state"), "sessions", "missing"),
    );
    expect(() => readSessionRecord(root, "missing")).toThrow(ElwoodError);
    const dir = sessionDir(root, "bad");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.json"), '{"schemaVersion":2,"elwoodSessionId":"bad"}');
    expect(() => readSessionRecord(root, "bad")).toThrow(ElwoodError);
    const corruptDir = sessionDir(root, "corrupt");
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(join(corruptDir, "session.json"), "{");
    expect(() => readSessionRecord(root, "corrupt")).toThrow(ElwoodError);
    const invalidWarning = createSessionRecord({ stateDir: root, cwd: root, id: "bad-warning" });
    writeSessionRecord({
      ...invalidWarning,
      warnings: [{ code: "mcp_server_not_logged_in", severity: "warning" } as never],
    });
    expect(() => readSessionRecord(root, invalidWarning.elwoodSessionId)).toThrow(ElwoodError);
    const record = createSessionRecord({ stateDir: root, cwd: root, id: "null-path" });
    writeSessionRecord({ ...record, paths: { ...record.paths, socketPath: "/tmp/foreign.sock" } });
    expect(() => readSessionRecord(root, record.elwoodSessionId)).toThrow(ElwoodError);
    expect(() =>
      removeSessionDir({ ...record, paths: { ...record.paths, sessionDir: "\0" } }),
    ).toThrow(ElwoodError);
  });

  test("C-STATE-03 C-STATE-11 custom state directories do not receive or overwrite gitignore files", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-state-"));
    const projectState = join(root, ".elwood");
    prepareStateDir(projectState, { gitignore: true });
    expect(readFileSync(join(projectState, ".gitignore"), "utf8")).toBe("*\n");
    const record = createSessionRecord({ stateDir: root, cwd: root, id: "atomic" });
    writeSessionRecord(record);
    expect(readFileSync(join(record.paths.sessionDir, "session.json"), "utf8")).toContain(
      record.elwoodSessionId,
    );
    writeFileSync(join(projectState, ".gitignore"), "!keep\n");
    prepareStateDir(projectState, { gitignore: true });
    expect(readFileSync(join(projectState, ".gitignore"), "utf8")).toBe("!keep\n");
    const customState = join(root, "custom-state");
    prepareStateDir(customState);
    expect(existsSync(join(customState, ".gitignore"))).toBe(false);
  });

  test("C-API-14 warning upserts refresh snapshots without duplicating events", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-state-"));
    const record = createSessionRecord({ stateDir: root, cwd: root, id: "warning-upsert" });
    const first = upsertSessionWarning(record, {
      elwoodSessionId: record.elwoodSessionId,
      agent: "codex",
      source: "terminal",
      code: "mcp_startup_incomplete",
      severity: "warning",
      message: "failed once",
      failedServers: ["linear"],
      recoveryCommands: ["codex mcp login linear"],
      raw: "old",
    });
    const second = upsertSessionWarning(first.record, {
      ...first.record.warnings[0]!,
      message: "failed twice",
      raw: "new",
    });
    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);
    expect(second.record.warnings).toHaveLength(1);
    expect(second.record.warnings[0]).toMatchObject({ message: "failed twice", raw: "new" });
  });

  test("C-API-14 persisted warning variants validate on read", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-state-"));
    const record = createSessionRecord({ stateDir: root, cwd: root, id: "warning-variants" });
    writeSessionRecord({
      ...record,
      warnings: [
        {
          elwoodSessionId: record.elwoodSessionId,
          agent: "claude",
          source: "lifecycle",
          code: "version_unparseable",
          severity: "warning",
          message: "unknown version",
          raw: "unknown",
        },
        {
          elwoodSessionId: record.elwoodSessionId,
          agent: "codex",
          source: "terminal",
          code: "mcp_startup_incomplete",
          severity: "warning",
          message: "failed",
          failedServers: ["linear"],
          recoveryCommands: ["codex mcp login linear"],
          raw: "MCP startup incomplete (failed: linear)",
        },
      ],
    });
    expect(readSessionRecord(root, record.elwoodSessionId).warnings).toHaveLength(2);
    const unknown = createSessionRecord({ stateDir: root, cwd: root, id: "unknown-warning" });
    writeSessionRecord({
      ...unknown,
      warnings: [{ code: "future_warning", severity: "warning" } as never],
    });
    expect(() => readSessionRecord(root, unknown.elwoodSessionId)).toThrow(ElwoodError);
  });
});
