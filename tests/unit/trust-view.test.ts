/** Native candidate provenance and positive clear evidence (C-TRUST-01/C-ATTN-03). */
import { expect, test } from "vitest";
import { withTrustBlockingRules } from "../../src/core/trust/blocking.ts";
import { trustView } from "../../src/core/trust/view.ts";
import { claudeComposer, codexComposer, codexSmallComposer } from "../fixtures/trust-composer.ts";

test.each([
  ["claude", claudeComposer],
  ["codex", codexComposer],
  ["codex", codexSmallComposer],
] as const)("C-TRUST-01 the captured %s composer positively confirms clearance", (agent, frame) => {
  expect(trustView(frame, agent)).toEqual({ kind: "clear" });
});

test("C-TRUST-01 synthetic crop keeps Claude's captured border and native footer evidence", () => {
  // This is a cropped existing capture, not a separately observed native layout.
  const cropped = claudeComposer.slice(claudeComposer.indexOf("───"));
  expect(trustView(cropped, "claude")).toEqual({ kind: "clear" });
  expect(trustView(cropped.replace(/-- INSERT --.*/, "unknown footer"), "claude")).toEqual({
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
  expect(trustView(frame, agent)).toEqual({ kind: "unknown" });
});

test.each([
  "",
  "Unknown explanatory prose\n",
  "● Unknown explanatory bullet\n1. Yes",
  "assistant: unknown tail\n1. Yes",
  "1. Yes\nUnknown footer\n",
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
  expect(withTrustBlockingRules(base, "claude", true)).toBe(base);
  const codex = withTrustBlockingRules(base, "codex", false);
  expect(codex.rules.some((rule) => rule.match?.("Hooks need review\nUnknown copy"))).toBe(false);
  expect(
    codex.rules.some((rule) =>
      rule.match?.("Do you trust the contents of this directory?\nUnknown copy"),
    ),
  ).toBe(true);
});
