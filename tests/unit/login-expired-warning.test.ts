/**
 * Focused coverage for mid-session login-expiry detection (PRD §5.3/§5.7,
 * C-CLAUDE-18): the edge-detecting watcher, the content-free `login_expired`
 * warning builder, and its persisted-state validation round-trip.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { isClaudeReauthRequiredText } from "../../src/claude/login/expiry-screen.ts";
import {
  LOGIN_RECOVERY_COMMAND,
  LoginExpiredWatcher,
  loginExpiredWarning,
} from "../../src/claude/login-expired.ts";
import { createSessionRecord } from "../../src/state/store.ts";
import { validateSessionRecord } from "../../src/state/validate.ts";

const id = "login-expired-target";

describe("isClaudeReauthRequiredText", () => {
  test("matches the CLI's lapsed/revoked banners and ignores unrelated login text", () => {
    expect(isClaudeReauthRequiredText("Login expired\n Please run /login")).toBe(true);
    expect(isClaudeReauthRequiredText("Session expired. Please run /login to sign in again.")).toBe(
      true,
    );
    expect(isClaudeReauthRequiredText("OAuth token revoked\n Please run /login")).toBe(true);
    expect(isClaudeReauthRequiredText("Run /login to sign in with your claude.ai account")).toBe(
      true,
    );
    // No /login recovery directive → not an expiry banner.
    expect(isClaudeReauthRequiredText("login page loaded")).toBe(false);
    expect(isClaudeReauthRequiredText("expired certificate warning")).toBe(false);
  });
});

describe("LoginExpiredWatcher", () => {
  test("C-CLAUDE-18 fires once on the raised edge and re-arms only after the banner clears", () => {
    const w = new LoginExpiredWatcher();
    // First appearance raises; a persistent banner across frames does NOT re-raise.
    expect(w.observe("Login expired\n Please run /login")).toBe(true);
    expect(w.observe("Login expired\n Please run /login")).toBe(false);
    // Banner clears (a normal composer frame), then a genuine re-expiry raises again.
    expect(w.observe("❯ ready again")).toBe(false);
    expect(w.observe("Session expired. Please run /login to sign in again.")).toBe(true);
  });
});

describe("loginExpiredWarning", () => {
  test("carries only the bounded /login recovery command, no raw banner", () => {
    const warning = loginExpiredWarning(id);
    expect(warning).toMatchObject({
      code: "login_expired",
      agent: "claude",
      source: "terminal",
      recoveryCommand: LOGIN_RECOVERY_COMMAND,
    });
    expect(warning.raw).toBe("login_expired recovery=/login");
  });
});

describe("C-CLAUDE-18 login_expired validation round-trip", () => {
  test("accepts a well-formed warning and gates malformed shapes", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-login-"));
    const record = JSON.parse(
      JSON.stringify(createSessionRecord({ stateDir: root, cwd: root, id })),
    ) as Record<string, unknown>;
    const warning = loginExpiredWarning(id);
    expect(validateSessionRecord({ ...record, warnings: [warning] }, root, id)).not.toBeNull();
    // Off-agent, wrong source, a non-/login recovery command, or a missing field all fail.
    for (const bad of [
      { agent: "codex" },
      { source: "lifecycle" },
      { recoveryCommand: "/relogin" },
      { recoveryCommand: 5 },
      { message: 9 },
    ]) {
      expect(
        validateSessionRecord({ ...record, warnings: [{ ...warning, ...bad }] }, root, id),
      ).toBeNull();
    }
  });

  test("C-CLAUDE-18 STRICT: a non-canonical message/raw or ANY extra key is rejected", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-login-strict-"));
    const record = JSON.parse(
      JSON.stringify(createSessionRecord({ stateDir: root, cwd: root, id })),
    ) as Record<string, unknown>;
    const warning = loginExpiredWarning(id);
    const validate = (w: Record<string, unknown>) =>
      validateSessionRecord({ ...record, warnings: [w] }, root, id);

    // The message/raw must be the EXACT canonical constants: a resumed warning may
    // not smuggle a raw banner or conversation text back to disk.
    expect(
      validate({ ...warning, message: "Your login expired: <leaked banner text>" }),
    ).toBeNull();
    expect(validate({ ...warning, raw: "login_expired recovery=/login extra=leak" })).toBeNull();
    // A well-formed warning with ONE unexpected (content-bearing) property fails —
    // the validator requires exactly the canonical key set, no extras.
    expect(validate({ ...warning, bannerText: "Login expired\n Please run /login" })).toBeNull();
    expect(validate({ ...warning, note: "" })).toBeNull();
    // Removing a required key also fails (exact-key check is symmetric).
    const { raw: _raw, ...missingRaw } = warning;
    expect(validate(missingRaw as Record<string, unknown>)).toBeNull();
  });
});
