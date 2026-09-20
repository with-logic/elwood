/** Positive Codex composer clearance after dialog replacement (PRD §5.4, C-TRUST-01). */
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { codexTrustClearance } from "../../../src/codex/screen-table.ts";
import { codexComposer, codexSmallComposer } from "../../fixtures/trust-composer.ts";

const welcomeOnly = codexComposer.slice(0, codexComposer.lastIndexOf("\n"));

const capturedComposer = readFileSync(
  new URL("../../fixtures/codex-0.142.5/composer-model-only.txt", import.meta.url),
  "utf8",
);

test.each([
  capturedComposer,
  codexComposer,
  codexSmallComposer,
  welcomeOnly,
  `1. First step\n2. Second step\n${codexSmallComposer}`,
  "› Explain this codebase\n  gpt-5.5 high",
  "› \n  gpt-5.5 high\n? for shortcuts",
])("C-TRUST-01 native composer proves clearance below transcript content: %s", (frame) => {
  expect(codexTrustClearance(frame)).toBe(true);
});

test.each([
  "",
  "› ",
  "Continue?\n› ",
  "› Enable admin access",
  "› Ask Codex to do anything",
  welcomeOnly.replace("Ask Codex to do anything", ""),
  welcomeOnly.replace(/╰─+╯/, ""),
  `${codexSmallComposer}\n1. Yes\n2. No`,
  `${codexSmallComposer}\n❯ Yes, go ahead\nNo, cancel`,
  `${codexSmallComposer}\n› `,
  codexSmallComposer.replace("gpt-5.6-sol low", "Unknown app"),
  codexSmallComposer.replace("/tmp/elwood-composer-CAPTURE/p…", "unknown text"),
])("C-TRUST-01 a partial or human-owned dialog cannot release input: %s", (frame) => {
  expect(codexTrustClearance(frame)).toBe(false);
});

test.each([
  "Summarize recent commits",
  "Implement {feature}",
  "Find and fix a bug in @filename",
  "Write tests for @filename",
  "Improve documentation in @filename",
  "Run /review on my current changes",
  "Use /skills to list available skills",
])("C-TRUST-01 recognizes Codex's native randomized placeholder: %s", (placeholder) => {
  expect(codexTrustClearance(`› ${placeholder}\n  gpt-5.5 high`)).toBe(true);
  expect(codexTrustClearance(`› ${placeholder}\n1. Yes\n2. No`)).toBe(false);
});
