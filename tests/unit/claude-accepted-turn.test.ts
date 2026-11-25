/**
 * Claude turn acceptance reads its submit hook as Claude's composer left the paste (PRD §5.8,
 * C-CLAUDE-25). The wrapped, tab, CRLF, trailing-whitespace and escaped forms follow hook
 * payloads captured from Claude Code 2.1.332 (`docs/cli-behavior.md`, "Claude native paste
 * presentation"); the foreign-id and mixed rows are constructed to pin what the reader refuses.
 */

import { describe, expect, test } from "vitest";
import { claudeAcceptanceSignal, echoesClaudePaste } from "../../src/claude/accepted-turn.ts";
import {
  acceptanceSignal,
  defaultAcceptanceSignal,
  registerAcceptanceSignal,
} from "../../src/core/simple/acceptance-signal.ts";

// The first four hex digits of sha256("claude-1"), the envelope id Claude derives from it.
const sessionId = "claude-1";
const block = (body: string, id = "c26a") =>
  `\n\n<pasted_content id="${id}">\n${body}\n</pasted_content id="${id}">\n`;
const submit = (prompt: string, fields: Record<string, unknown> = { session_id: sessionId }) => ({
  hook_event_name: "UserPromptSubmit",
  prompt,
  ...fields,
});
const echoes = (nativePrompt: string, payload: string) =>
  echoesClaudePaste(nativePrompt, payload, submit(nativePrompt));

describe("echoesClaudePaste", () => {
  test("C-CLAUDE-25 matches a payload through the composer's changes", () => {
    expect(
      echoes(
        block("tab    here\nsecond    line\nthird\nfourth\nfifth"),
        "tab\there\r\nsecond\tline\r\nthird\rfourth\r\nfifth",
      ),
    ).toBe(true);
    expect(echoes("tab    here\nsecond", "tab\there\r\nsecond")).toBe(true);
    expect(echoes("  padded", "  padded  ")).toBe(true);
    expect(echoes(block("a\nb\nc\nd\n"), "a\nb\nc\nd\n\n")).toBe(true);
  });

  test("C-CLAUDE-25 reads every `<\\` as `<` on both sides", () => {
    expect(echoes('a <\\pasted_content id="abcd"> b', 'a <pasted_content id="abcd"> b')).toBe(true);
    // Claude leaves a `<` a backslash already follows, so sent text can hold the escape.
    expect(echoes("a <\\pasted_content> b", "a <\\pasted_content> b")).toBe(true);
    // A look-alike tag spelled with a Cyrillic letter is escaped too (captured on 2.1.332).
    expect(
      echoes(block("one\n<\\pаsted_content>\nthree\nfour"), "one\n<pаsted_content>\nthree\nfour"),
    ).toBe(true);
  });

  test("C-CLAUDE-25 refuses other text, mixed prompts and another session's envelope", () => {
    expect(echoes(block("a\nb\nc\nd"), "a\nb\nc\ne")).toBe(false);
    expect(echoes(`typed ${block("a\nb\nc\nd")}`, "a\nb\nc\nd")).toBe(false);
    expect(echoes(block("a\nb\nc\nd", "ff71"), "a\nb\nc\nd")).toBe(false);
    const wrapped = block("a\nb\nc\nd");
    expect(echoesClaudePaste(wrapped, "a\nb\nc\nd", submit(wrapped, {}))).toBe(false);
  });
});

describe("Claude acceptance reader", () => {
  test("C-CLAUDE-25 accepts the session's wrapped submit hook that the default refuses", () => {
    const wrapped = submit(block("one\n    two\nthree\nfour"));
    const sent = "one\r\n\ttwo\nthree\nfour";
    expect(defaultAcceptanceSignal(wrapped, sent)).toBe(false);
    expect(claudeAcceptanceSignal(wrapped, sent)).toBe(true);
    expect(claudeAcceptanceSignal(wrapped, "something else")).toBe(false);
    expect(claudeAcceptanceSignal({ hook_event_name: "Stop" }, sent)).toBe(true);
    // A submit hook without a prompt echoes nothing.
    expect(claudeAcceptanceSignal({ hook_event_name: "UserPromptSubmit" }, "")).toBe(false);
  });

  test("C-CLAUDE-25 a session uses the reader it registered, else the default", () => {
    const session = {};
    expect(acceptanceSignal(session)).toBe(defaultAcceptanceSignal);
    registerAcceptanceSignal(session, claudeAcceptanceSignal);
    expect(acceptanceSignal(session)).toBe(claudeAcceptanceSignal);
  });
});
