/**
 * Focused coverage for mid-session login-expiry detection (PRD §5.3/§5.7,
 * C-CLAUDE-18): the edge-detecting watcher and the content-free `login_expired`
 * warning builder. The warning is live-only (never persisted).
 */

import { describe, expect, test } from "vitest";
import { isClaudeReauthRequiredText } from "../../src/claude/login/expiry-screen.ts";
import {
  LOGIN_RECOVERY_COMMAND,
  LoginExpiredWatcher,
  loginExpiredWarning,
} from "../../src/claude/login-expired.ts";

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
    // Content-free: the message names no raw banner text.
    expect(warning.message).not.toContain("banner");
  });
});
