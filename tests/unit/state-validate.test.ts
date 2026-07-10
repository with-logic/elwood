/**
 * Unit coverage for persisted session record validation and state file edges.
 * Covers PRD §8.2, §10, C-ERR-04, and C-STATE-08.
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
import { validateSessionRecord } from "../../src/state/validate.ts";

const id = "validate-target";

describe("session record validation", () => {
  test("C-ERR-04 rejects malformed top-level record shapes", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-validate-"));
    const base = jsonRecord(root);
    expect(validateSessionRecord("not-a-record", root, id)).toBeNull();
    expect(validateSessionRecord({ ...base, adapter: "gemini" }, root, id)).toBeNull();
    expect(validateSessionRecord({ ...base, bridgeToken: 7 }, root, id)).toBeNull();
    expect(validateSessionRecord({ ...base, cwd: 7 }, root, id)).toBeNull();
    expect(validateSessionRecord({ ...base, createdAt: 7 }, root, id)).toBeNull();
    expect(validateSessionRecord({ ...base, claude: "broken" }, root, id)).toBeNull();
    expect(validateSessionRecord({ ...base, terminalSize: "big" }, root, id)).toBeNull();
    expect(validateSessionRecord({ ...base, paths: "elsewhere" }, root, id)).toBeNull();
  });

  test("C-ERR-04 rejects warning entries that are not valid warning events", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-validate-"));
    const base = jsonRecord(root);
    expect(validateSessionRecord({ ...base, warnings: ["nope"] }, root, id)).toBeNull();
    expect(
      validateSessionRecord(
        { ...base, warnings: [{ ...versionWarning("claude"), severity: "info" }] },
        root,
        id,
      ),
    ).toBeNull();
  });

  test("C-API-14 accepts codex version and MCP login warning variants", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-validate-"));
    const base = jsonRecord(root);
    const valid = validateSessionRecord(
      { ...base, warnings: [versionWarning("codex"), mcpLoginWarning()] },
      root,
      id,
    );
    expect(valid?.warnings).toHaveLength(2);
  });

  test("C-STATE-13 validates the persisted launch posture shape", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-validate-"));
    const base = jsonRecord(root);
    const good = { ...base, claude: { launch: { permissionMode: "plan", tools: ["Read"] } } };
    expect(validateSessionRecord(good, root, id)).not.toBeNull();
    const bad = { ...base, claude: { launch: { tools: "Read" } } };
    expect(validateSessionRecord(bad, root, id)).toBeNull();
    expect(validateSessionRecord({ ...base, claude: { launch: "plan" } }, root, id)).toBeNull();
    expect(validateSessionRecord({ ...base, claude: { resumeId: 42 } }, root, id)).toBeNull();
  });

  test("C-CODEX-14 accepts and gates the codex_default_model_persisted warning", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-validate-"));
    const base = jsonRecord(root);
    const warning = {
      elwoodSessionId: id,
      agent: "codex",
      source: "lifecycle",
      code: "codex_default_model_persisted",
      severity: "warning",
      message: "restore skipped",
      raw: "/tmp/config.toml",
    };
    expect(validateSessionRecord({ ...base, warnings: [warning] }, root, id)).not.toBeNull();
    expect(
      validateSessionRecord({ ...base, warnings: [{ ...warning, source: "terminal" }] }, root, id),
    ).toBeNull();
  });

  test("C-CLAUDE-14 an unknown warning code (e.g. a removed trust_prompt_unanswerable) is rejected", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-validate-"));
    const base = jsonRecord(root);
    // The transient render-delay state no longer persists a durable warning, so a
    // stale/removed `trust_prompt_unanswerable` record must fall through to the
    // unknown-code rejection rather than round-trip back into the snapshot.
    const stale = {
      elwoodSessionId: id,
      agent: "claude",
      source: "terminal",
      code: "trust_prompt_unanswerable",
      severity: "warning",
      message: "no option for mcp_trust",
      prompt: "mcp_trust",
      raw: "prompt=mcp_trust",
    };
    const one = (w: object) => validateSessionRecord({ ...base, warnings: [w] }, root, id);
    expect(one(stale)).toBeNull(); // removed code: no longer a valid warning shape
    expect(one({ ...stale, code: "made_up_code" })).toBeNull(); // any unknown code rejects
  });
});
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

function jsonRecord(root: string): Record<string, unknown> {
  const record = createSessionRecord({ stateDir: root, cwd: root, id });
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}

function versionWarning(agent: "claude" | "codex"): Record<string, unknown> {
  return {
    elwoodSessionId: id,
    agent,
    source: "lifecycle",
    code: "version_unparseable",
    severity: "warning",
    message: "unparseable version",
    raw: "unknown",
  };
}

function mcpLoginWarning(): Record<string, unknown> {
  return {
    elwoodSessionId: id,
    agent: "codex",
    source: "terminal",
    code: "mcp_server_not_logged_in",
    severity: "warning",
    message: "linear is not logged in",
    mcpServerName: "linear",
    recoveryCommand: "codex mcp login linear",
    raw: "The linear MCP server is not logged in.",
  };
}

function throwPrimitive(value: string): never {
  // Throws a bare string to exercise non-Error failure normalization.
  throw value;
}
