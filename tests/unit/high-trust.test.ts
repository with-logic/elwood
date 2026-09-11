/**
 * Library-side `highTrust`: expansion into each adapter's most permissive posture
 * and conflict rejection, including at lazy-session construction. Launch-path
 * coverage lives in high-trust-launch.test.ts. Covers PRD §5.1/§5.5 (C-API-54).
 */

import { describe, expect, test } from "vitest";
import {
  applyClaudeHighTrust,
  applyCodexHighTrust,
  assertClaudeHighTrust,
  assertCodexHighTrust,
} from "../../src/core/high-trust.ts";
import { ClaudeSession, CodexSession } from "../../src/index.ts";

describe("highTrust expansion", () => {
  test("C-API-54 expands to bypassPermissions and drops the switch itself", () => {
    expect(applyClaudeHighTrust({ cwd: "/p", highTrust: true })).toEqual({
      cwd: "/p",
      permissionMode: "bypassPermissions",
    });
    const off = { cwd: "/p", highTrust: false, permissionMode: "plan" as const };
    expect(applyClaudeHighTrust(off)).toBe(off);
    const unset: { readonly cwd: string; readonly highTrust?: boolean } = { cwd: "/p" };
    expect(applyClaudeHighTrust(unset)).toBe(unset);
  });

  test("C-API-54 expands to danger-full-access + never on Codex", () => {
    expect(applyCodexHighTrust({ cwd: "/p", highTrust: true })).toEqual({
      cwd: "/p",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    });
    const explicit = { cwd: "/p", sandbox: "read-only" as const };
    expect(applyCodexHighTrust(explicit)).toBe(explicit);
  });

  test("C-API-54 rejects explicit per-agent posture alongside highTrust", () => {
    expect(() => assertClaudeHighTrust({ highTrust: true, permissionMode: "plan" })).toThrow(
      expect.objectContaining({
        code: "claude_high_trust_conflict",
        details: { permissionMode: "plan" },
      }),
    );
    expect(() => assertCodexHighTrust({ highTrust: true, sandbox: "read-only" })).toThrow(
      expect.objectContaining({
        code: "codex_high_trust_conflict",
        details: { explicit: "sandbox" },
      }),
    );
    expect(() => assertCodexHighTrust({ highTrust: true, approvalPolicy: "untrusted" })).toThrow(
      /explicit approvalPolicy;/u,
    );
    expect(() =>
      assertCodexHighTrust({ highTrust: true, sandbox: "read-only", approvalPolicy: "never" }),
    ).toThrow(/explicit sandbox or approvalPolicy;/u);
    expect(() => assertCodexHighTrust({ highTrust: false, sandbox: "read-only" })).not.toThrow();
    expect(() => assertCodexHighTrust({ highTrust: true })).not.toThrow();
  });

  test("C-API-54 the lazy session classes reject the conflict at construction", () => {
    expect(() => new ClaudeSession({ highTrust: true, permissionMode: "plan" })).toThrow(
      expect.objectContaining({ code: "claude_high_trust_conflict" }),
    );
    expect(() => new CodexSession({ highTrust: true, approvalPolicy: "on-request" })).toThrow(
      expect.objectContaining({ code: "codex_high_trust_conflict" }),
    );
    expect(new ClaudeSession({ highTrust: true }).status).toBe("starting");
    expect(new CodexSession({ highTrust: true }).status).toBe("starting");
  });
});
