/**
 * Unit coverage for persisted session record validation.
 * Covers PRD §8.2, §10, C-ERR-04, and C-STATE-13.
 */

import { describe, expect, test } from "vitest";
import { createSessionRecord } from "../../src/state/store.ts";
import { validateSessionRecord } from "../../src/state/validate.ts";
import { tempDir } from "../helpers/tmp.ts";

const id = "validate-target";

describe("session record validation", () => {
  test("C-ERR-04 rejects malformed top-level record shapes", () => {
    const root = tempDir("elwood-validate-");
    const base = jsonRecord(root);
    expect(validateSessionRecord("not-a-record", id)).toBeNull();
    expect(validateSessionRecord({ ...base, adapter: "gemini" }, id)).toBeNull();
    expect(validateSessionRecord({ ...base, schemaVersion: 2 }, id)).toBeNull();
    expect(validateSessionRecord({ ...base, elwoodSessionId: "other-id" }, id)).toBeNull();
    expect(validateSessionRecord({ ...base, cwd: 7 }, id)).toBeNull();
    expect(validateSessionRecord({ ...base, claude: "broken" }, id)).toBeNull();
    expect(validateSessionRecord({ ...base, codex: "broken" }, id)).toBeNull();
    expect(validateSessionRecord(base, id)).not.toBeNull();
  });

  test("§8.2 strips legacy fields — a validated record carries ONLY the minimal shape", () => {
    // A schema-v1 record written by an older Elwood carries removed fields (a stale
    // bridge token / IPC credential, paths, warnings, metadata, terminal size) plus
    // adapter-state extras (a `name`). validateSessionRecord must return a FRESH
    // canonical record with none of them, so the next write can never round-trip a
    // retired credential back onto disk.
    const root = tempDir("elwood-validate-");
    const legacy = {
      ...jsonRecord(root),
      bridgeToken: "stale-secret",
      paths: { sessionDir: "/old", socketPath: "/old/h.sock" },
      warnings: [{ code: "version_unparseable" }],
      metadata: { anything: 1 },
      terminalSize: { cols: 80, rows: 24 },
      status: "ready",
      createdAt: "2020-01-01T00:00:00.000Z",
      claude: { resumeId: "c1", name: "old-name", launch: {} },
      codex: {},
    };
    const validated = validateSessionRecord(legacy, id);
    expect(validated).not.toBeNull();
    expect(Object.keys(validated ?? {}).sort()).toEqual([
      "adapter",
      "claude",
      "codex",
      "cwd",
      "elwoodSessionId",
      "schemaVersion",
    ]);
    // The retained adapter state carries only resumeId + launch — no legacy `name`.
    expect(Object.keys(validated?.claude ?? {}).sort()).toEqual(["launch", "resumeId"]);
    expect(JSON.stringify(validated)).not.toContain("stale-secret");
  });

  test("C-STATE-13 validates the persisted launch posture shape", () => {
    const root = tempDir("elwood-validate-");
    const base = jsonRecord(root);
    const good = { ...base, claude: { launch: { permissionMode: "plan", tools: ["Read"] } } };
    expect(validateSessionRecord(good, id)).not.toBeNull();
    const bad = { ...base, claude: { launch: { tools: "Read" } } };
    expect(validateSessionRecord(bad, id)).toBeNull();
    expect(validateSessionRecord({ ...base, claude: { launch: "plan" } }, id)).toBeNull();
    expect(validateSessionRecord({ ...base, claude: { resumeId: 42 } }, id)).toBeNull();
    expect(validateSessionRecord({ ...base, claude: { launch: {} } }, id)).not.toBeNull();
    expect(validateSessionRecord({ ...base, claude: { resumeId: "native" } }, id)).not.toBeNull();
  });

  test("C-STATE-13 rejects an out-of-union Claude permissionMode", () => {
    const root = tempDir("elwood-validate-");
    const base = jsonRecord(root);
    const bad = { ...base, claude: { launch: { permissionMode: "yolo" } } };
    expect(validateSessionRecord(bad, id)).toBeNull();
  });

  test("C-STATE-13 rejects Claude posture carrying codex-only fields", () => {
    const root = tempDir("elwood-validate-");
    const base = jsonRecord(root);
    const bad = { ...base, claude: { launch: { sandbox: "read-only" } } };
    expect(validateSessionRecord(bad, id)).toBeNull();
  });

  test("C-STATE-13 accepts an in-union codex sandbox and approval policy", () => {
    const root = tempDir("elwood-validate-");
    const base = codexRecord(root);
    const good = {
      ...base,
      codex: { launch: { sandbox: "workspace-write", approvalPolicy: "on-request" } },
    };
    expect(validateSessionRecord(good, id)).not.toBeNull();
  });

  test("C-STATE-13 rejects an out-of-union codex sandbox", () => {
    const root = tempDir("elwood-validate-");
    const base = codexRecord(root);
    const bad = { ...base, codex: { launch: { sandbox: "not-a-mode" } } };
    expect(validateSessionRecord(bad, id)).toBeNull();
  });

  test("C-STATE-13 rejects an out-of-union codex approvalPolicy", () => {
    const root = tempDir("elwood-validate-");
    const base = codexRecord(root);
    const bad = { ...base, codex: { launch: { approvalPolicy: "sometimes" } } };
    expect(validateSessionRecord(bad, id)).toBeNull();
  });

  test("C-STATE-13 rejects codex posture carrying claude-only fields", () => {
    const root = tempDir("elwood-validate-");
    const base = codexRecord(root);
    const bad = { ...base, codex: { launch: { permissionMode: "plan" } } };
    expect(validateSessionRecord(bad, id)).toBeNull();
  });
});

function jsonRecord(root: string): Record<string, unknown> {
  const record = createSessionRecord({ cwd: root, id });
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}

function codexRecord(root: string): Record<string, unknown> {
  const record = createSessionRecord({ cwd: root, id, adapter: "codex" });
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}
