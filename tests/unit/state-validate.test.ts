/**
 * Unit coverage for persisted session record validation.
 * Covers PRD §8.2, §10, C-ERR-04, C-API-14, C-STATE-13, and C-CLAUDE-14.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createSessionRecord } from "../../src/state/store.ts";
import { validateSessionRecord } from "../../src/state/validate.ts";

const id = "validate-target";

describe("session record validation", () => {
  test("C-ERR-04 rejects malformed top-level record shapes", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-validate-"));
    const base = jsonRecord(root);
    expect(validateSessionRecord("not-a-record", root, id)).toBeNull();
    expect(validateSessionRecord({ ...base, adapter: "gemini" }, root, id)).toBeNull();
    expect(validateSessionRecord({ ...base, elwoodSessionId: "other-id" }, root, id)).toBeNull();
    expect(validateSessionRecord({ ...base, bridgeToken: 7 }, root, id)).toBeNull();
    expect(validateSessionRecord({ ...base, cwd: 7 }, root, id)).toBeNull();
    expect(validateSessionRecord({ ...base, createdAt: 7 }, root, id)).toBeNull();
    expect(validateSessionRecord({ ...base, claude: "broken" }, root, id)).toBeNull();
    expect(validateSessionRecord({ ...base, terminalSize: "big" }, root, id)).toBeNull();
    expect(
      validateSessionRecord({ ...base, terminalSize: { cols: 80, rows: 1.5 } }, root, id),
    ).toBeNull();
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
    expect(validateSessionRecord({ ...base, claude: { launch: {} } }, root, id)).not.toBeNull();
  });

  test("C-STATE-13 rejects an out-of-union Claude permissionMode", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-validate-"));
    const base = jsonRecord(root);
    const bad = { ...base, claude: { launch: { permissionMode: "yolo" } } };
    expect(validateSessionRecord(bad, root, id)).toBeNull();
  });

  test("C-STATE-13 rejects Claude posture carrying codex-only fields", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-validate-"));
    const base = jsonRecord(root);
    const bad = { ...base, claude: { launch: { sandbox: "read-only" } } };
    expect(validateSessionRecord(bad, root, id)).toBeNull();
  });

  test("C-STATE-13 accepts an in-union codex sandbox and approval policy", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-validate-"));
    const base = codexRecord(root);
    const good = {
      ...base,
      codex: { launch: { sandbox: "workspace-write", approvalPolicy: "on-request" } },
    };
    expect(validateSessionRecord(good, root, id)).not.toBeNull();
  });

  test("C-STATE-13 rejects an out-of-union codex sandbox", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-validate-"));
    const base = codexRecord(root);
    const bad = { ...base, codex: { launch: { sandbox: "not-a-mode" } } };
    expect(validateSessionRecord(bad, root, id)).toBeNull();
  });

  test("C-STATE-13 rejects an out-of-union codex approvalPolicy", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-validate-"));
    const base = codexRecord(root);
    const bad = { ...base, codex: { launch: { approvalPolicy: "sometimes" } } };
    expect(validateSessionRecord(bad, root, id)).toBeNull();
  });

  test("C-STATE-13 rejects codex posture carrying claude-only fields", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-validate-"));
    const base = codexRecord(root);
    const bad = { ...base, codex: { launch: { permissionMode: "plan" } } };
    expect(validateSessionRecord(bad, root, id)).toBeNull();
  });

  test("C-CLAUDE-14 an unknown warning code (e.g. a removed trust_prompt_unanswerable) is rejected", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-validate-"));
    const base = jsonRecord(root);
    // A stale/removed `trust_prompt_unanswerable` record falls through to the
    // unknown-code rejection rather than round-tripping back into the snapshot.
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

function jsonRecord(root: string): Record<string, unknown> {
  const record = createSessionRecord({ stateDir: root, cwd: root, id });
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}

function codexRecord(root: string): Record<string, unknown> {
  const record = createSessionRecord({ stateDir: root, cwd: root, id, adapter: "codex" });
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
