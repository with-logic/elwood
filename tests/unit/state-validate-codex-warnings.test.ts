/**
 * Validation coverage for Codex lifecycle warnings (PRD §8.2, §10): the
 * model-persisted and content-free clipboard-restore-failed diagnostics.
 * Covers C-CODEX-14 and C-API-46.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createSessionRecord } from "../../src/state/store.ts";
import { validateSessionRecord } from "../../src/state/validate.ts";
import { CLIPBOARD_RESTORE_FAILED_MESSAGE } from "../../src/state/validate-warnings.ts";

const id = "validate-target";

function jsonRecord(root: string): Record<string, unknown> {
  const record = createSessionRecord({ stateDir: root, cwd: root, id });
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}

describe("Codex lifecycle warning validation", () => {
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
    const one = (w: object) => validateSessionRecord({ ...base, warnings: [w] }, root, id);
    expect(one(warning)).not.toBeNull();
    expect(one({ ...warning, source: "terminal" })).toBeNull();
  });

  test("C-API-46 gates clipboard_restore_failed to canonical content-free copy only", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-validate-"));
    const base = jsonRecord(root);
    const clip = {
      elwoodSessionId: id,
      agent: "codex",
      source: "lifecycle",
      code: "clipboard_restore_failed",
      severity: "warning",
      message: CLIPBOARD_RESTORE_FAILED_MESSAGE,
      raw: "clipboard_restore_failed",
    };
    const one = (w: object) => validateSessionRecord({ ...base, warnings: [w] }, root, id);
    // Exact message/raw pass; a tampered raw (sneaked path) or extra key is rejected,
    // so no clipboard content can ride through this bounded channel.
    expect(one(clip)).not.toBeNull();
    expect(one({ ...clip, raw: "/tmp/secret" })).toBeNull();
    expect(one({ ...clip, extra: "leak" })).toBeNull();
  });
});
