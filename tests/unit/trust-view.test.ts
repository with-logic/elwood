/** Native candidate provenance and positive clear evidence (C-TRUST-01/C-ATTN-03). */
import { expect, test } from "vitest";
import { claudeTrustClearance } from "../../src/claude/screen-table.ts";
import { withTrustBlockingRules } from "../../src/core/trust/blocking.ts";
import { trustView } from "../../src/core/trust/view.ts";
import {
  claudeBody,
  claudeComposer,
  claudeTrust,
  clearanceFor,
  codexComposer,
  codexHooks,
  codexSmallComposer,
  codexTrust,
} from "../fixtures/trust-composer.ts";

test.each([
  ["claude", claudeComposer],
  ["codex", codexComposer],
  ["codex", codexSmallComposer],
] as const)("C-TRUST-01 the captured %s composer positively confirms clearance", (agent, frame) => {
  expect(trustView(frame, agent, clearanceFor(agent))).toEqual({ kind: "clear" });
});

test("C-TRUST-01 synthetic crop keeps Claude's captured border and native footer evidence", () => {
  // This is a cropped existing capture, not a separately observed native layout.
  const cropped = claudeComposer.slice(claudeComposer.indexOf("───"));
  expect(trustView(cropped, "claude", claudeTrustClearance)).toEqual({ kind: "clear" });
  expect(
    trustView(cropped.replace(/-- INSERT --.*/, "unknown footer"), "claude", claudeTrustClearance),
  ).toEqual({
    kind: "unknown",
  });
});

test.each([
  ["claude", "Ready\n❯"],
  ["codex", "Ready\n›"],
  ["claude", `${claudeComposer}\n1. Yes`],
  ["codex", `${codexComposer}\n❯ 1. Yes`],
  ["claude", `${claudeComposer}\n❯ Enable admin access`],
  ["codex", `${codexComposer}\n› Enable admin access`],
  ["codex", `${codexSmallComposer}\n❯ Enable admin access`],
  ["claude", claudeComposer.replace('❯ Try "fix typecheck errors"', "❯ Yes")],
  ["codex", codexComposer.replace("› Ask Codex to do anything", "› Enable admin access")],
  ["codex", codexComposer.replace(/╰─+╯/, "").replace(/gpt-6-astra default.*/, "")],
  ["codex", codexSmallComposer.replace("gpt-5.6-sol low", "Unknown app")],
  ["codex", codexSmallComposer.replace("/tmp/elwood-composer-CAPTURE/p…", "unknown text")],
  ["claude", "WARNING: unrelated operation\n1. Yes"],
] as const)("C-TRUST-01 unknown or selectable %s screens do not prove clearance: %s", (agent, frame) => {
  expect(trustView(frame, agent, clearanceFor(agent))).toEqual({ kind: "unknown" });
});

test.each([
  "",
  "Unknown explanatory prose\n",
  "● Unknown explanatory bullet\n1. Yes",
  "assistant: unknown tail\n1. Yes",
  "1. Yes\nUnknown footer\n",
  "1. Yes\n2. No\n\nDo you like this?",
])("C-ATTN-03 unsupported unauthorized native candidates remain human-blocking: %s", (tail) => {
  const table = withTrustBlockingRules(
    { agent: "claude" as const, verifiedAgainst: "test", rules: [] },
    "claude",
    false,
  );
  const frame = `Do you trust this folder?\n${tail}`;
  expect(table.rules.some((rule) => rule.match?.(frame))).toBe(true);
  for (const prefix of [
    "● Assistant says",
    "• Assistant says",
    "user: quoted text",
    "❯ User says",
  ]) {
    expect(table.rules.some((rule) => rule.match?.(`${prefix}\n${frame}`))).toBe(false);
  }
});

test("C-ATTN-03 static human rules omit automation-owned trust candidates", () => {
  const base = { agent: "claude" as const, verifiedAgainst: "test", rules: [] };
  // Only the hold-only off-allowlist fallback remains; no allowlisted prompt gets a static rule.
  const owned = withTrustBlockingRules(base, "claude", true).rules.map((rule) => rule.id);
  expect(owned).toEqual(["claude-unknown_gate-prompt"]);
  const codex = withTrustBlockingRules(base, "codex", false);
  expect(codex.rules.some((rule) => rule.match?.("Hooks need review\nUnknown copy"))).toBe(false);
  expect(
    codex.rules.some((rule) =>
      rule.match?.("Do you trust the contents of this directory?\nUnknown copy"),
    ),
  ).toBe(true);
});

test("C-TRUST-01 header-like text below a known gate holds input and authorizes no key", () => {
  const frame = `${claudeTrust}\n1. Yes\n2. No\n\nDo you like this?`;
  expect(trustView(frame, "claude", claudeTrustClearance)).toMatchObject({
    kind: "candidate",
    valid: false,
  });
});

const bypass =
  "WARNING: Claude Code running in Bypass Permissions mode\nIn Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.";
test.each([
  ["claude", claudeTrust, "❯ Yes, I trust this folder\n  No, exit"],
  ["claude", `Is this a project you created or one you trust?\n${claudeBody}`, "1. Yes\n2. No"],
  ["claude", `${claudeTrust.split("\n")[0]}\n${claudeBody.split("\n")[2]}`, "1. Yes\n2. No"],
  ["claude", bypass, "1. No, exit\n2. Yes, I accept"],
  ["codex", codexTrust, "› 1. Yes, continue\n  2. No, quit"],
  ["codex", codexHooks, "1. Review hooks\n2. Trust all and continue"],
] as const)("C-TRUST-01 a %s header without its whole native body holds input but authorizes no key: %s", (agent, region, options) => {
  const header = /^[^?\n]+\??/.exec(region)?.[0];
  for (const partial of [
    header,
    `${header}\nSecurity guide`,
    `${header}\n1 hook is new or changed.`,
  ]) {
    const held = trustView(`${partial}\n${options}`, agent, clearanceFor(agent));
    expect(held).toMatchObject({ kind: "candidate", valid: false, option: undefined });
  }
  // Every truncation of the native copy is a half-painted body: only whole sentences answer.
  const whole = /(?:folder first|files here|dangerous commands|to load|trust them)\.$|guide$/;
  for (let end = (header as string).length; end < region.length; end++) {
    const partial = region.slice(0, end).trimEnd();
    const view = trustView(`${partial}\n${options}`, agent, clearanceFor(agent));
    expect([partial, view.kind, "valid" in view && view.valid]).toEqual([
      partial,
      "candidate",
      whole.test(partial),
    ]);
    if (!whole.test(partial)) expect(view).toMatchObject({ option: undefined });
  }
  const complete = trustView(`${region}\n${options}`, agent, clearanceFor(agent));
  expect(complete).toMatchObject({ kind: "candidate", valid: true });
  expect(complete.kind === "candidate" && complete.option?.label).toMatch(/Yes|Trust all/);
});

test("C-CLAUDE-14 gates with no captured native body stay answerable from their header", () => {
  const view = trustView(
    "Load this skill?\n1. Yes, load this skill\n2. No",
    "claude",
    claudeTrustClearance,
  );
  expect(view).toMatchObject({ kind: "candidate", valid: true, option: { number: "1" } });
});
