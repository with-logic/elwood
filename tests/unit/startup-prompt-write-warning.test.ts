/**
 * Persistence coverage for the startup_prompt_write_failed warning.
 * Covers PRD §5.4/§5.7/§8.2 (C-CLAUDE-16, C-CODEX-17): the bounded write-failure
 * warning keys distinct prompts separately and only round-trips an allowlisted label.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createSessionRecord, upsertSessionWarning } from "../../src/state/store.ts";
import { validateSessionRecord } from "../../src/state/validate.ts";

const id = "write-failed";

function base() {
  const root = mkdtempSync(join(tmpdir(), "elwood-write-failed-"));
  const record = createSessionRecord({ stateDir: root, cwd: root, id });
  return { root, record };
}

function writeFailed(elwoodSessionId: string, label: string) {
  return {
    elwoodSessionId,
    agent: "claude" as const,
    source: "terminal" as const,
    code: "startup_prompt_write_failed" as const,
    severity: "warning" as const,
    message: `write to ${label} rejected`,
    label: label as "workspace_trust" | "browser_tools",
    raw: `startup_prompt_write_failed label=${label}`,
  };
}

describe("startup_prompt_write_failed persistence", () => {
  test("C-CLAUDE-16 keys on code AND label so distinct prompts are separate incidents", () => {
    const { record } = base();
    const trust = upsertSessionWarning(
      record,
      writeFailed(record.elwoodSessionId, "workspace_trust"),
    );
    // A different prompt's failed write is a DISTINCT incident (not deduped)...
    const browser = upsertSessionWarning(
      trust.record,
      writeFailed(record.elwoodSessionId, "browser_tools"),
    );
    // ...while a retry of the SAME prompt collapses onto the existing incident.
    const retry = upsertSessionWarning(
      browser.record,
      writeFailed(record.elwoodSessionId, "workspace_trust"),
    );
    expect(trust.isNew).toBe(true);
    expect(browser.isNew).toBe(true);
    expect(retry.isNew).toBe(false);
    expect(retry.record.warnings).toHaveLength(2);
  });

  test("C-CLAUDE-16 C-CODEX-17 validates the warning and gates a raw label on read", () => {
    const { root, record } = base();
    const serialized = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
    const warning = writeFailed(id, "workspace_trust");
    const one = (w: object) => validateSessionRecord({ ...serialized, warnings: [w] }, root, id);
    expect(one(warning)).not.toBeNull(); // valid claude terminal warning
    expect(one({ ...warning, agent: "codex", label: "hook_trust" })).not.toBeNull(); // codex too
    expect(one({ ...warning, source: "lifecycle" })).toBeNull(); // wrong source
    expect(one({ ...warning, agent: "gemini" })).toBeNull(); // unknown agent
    // The label is bounded to the fixed startup-prompt label set, so a non-string or
    // a raw (possibly conversation-derived) label is rejected, never round-tripped.
    for (const bad of [5, undefined, "leakedPromptText", "some_unknown_prompt"]) {
      expect(one({ ...warning, label: bad })).toBeNull();
    }
  });
});
