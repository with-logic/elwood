/**
 * The trust-policy blocking rules (autotrust OFF) recognize a prompt only by its
 * HEADER on a NON-option line — the SAME option-aware recognizer the responder
 * uses — so a numbered option whose label merely contains a trust phrase is never
 * misclassified as a blocking trust prompt. Covers PRD §5.1 and C-ATTN-03.
 */

import { describe, expect, test } from "vitest";
import { claudeScreenFactTableForTrustPolicy } from "../../src/claude/screen-table.ts";
import { codexScreenFactTableForTrustPolicy } from "../../src/codex/screen-table.ts";
import { type RenderedFrame, readScreenFacts } from "../../src/core/screen-facts.ts";

const screen = (text: string): RenderedFrame => ({ text, title: "" });
const claudeBlocking = claudeScreenFactTableForTrustPolicy(false);
const codexBlocking = codexScreenFactTableForTrustPolicy(false);

describe("C-ATTN-03 trust-policy blocking rules are option-aware", () => {
  test("a real trust HEADER on a non-option line does block when autotrust is off", () => {
    // Sanity: with the header on its own line, the blocking rule still fires.
    expect(
      readScreenFacts(claudeBlocking, screen("Do you trust this folder?\n1. Yes\n2. No")).facts
        .blocking_prompt_visible,
    ).toBe(true);
    expect(
      readScreenFacts(
        codexBlocking,
        screen("Do you trust the contents of this directory?\n› 1. Yes\n  2. No"),
      ).facts.blocking_prompt_visible,
    ).toBe(true);
  });

  test("an OPTION-ONLY trust phrase does NOT produce blocking_prompt_visible (claude)", () => {
    // An unrelated dialog whose numbered OPTION merely contains a trust phrase
    // ("2. Do you trust this MCP server?") must not be misclassified as a blocking
    // trust prompt — a header regex applied raw to the full frame would have.
    const frame = screen(
      "Unrelated migration dialog\n1. Trust the plugin?\n2. Do you trust this MCP server?",
    );
    expect(readScreenFacts(claudeBlocking, frame).facts.blocking_prompt_visible).toBe(false);
  });

  test("an OPTION-ONLY trust phrase does NOT produce blocking_prompt_visible (codex)", () => {
    // Codex's directory-trust header text living ONLY inside an option label must
    // not classify as a blocking prompt.
    const frame = screen(
      "Unrelated confirmation\n› 1. Do you trust the contents of this directory?\n  2. No",
    );
    expect(readScreenFacts(codexBlocking, frame).facts.blocking_prompt_visible).toBe(false);
  });
});
