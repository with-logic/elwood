/** Sanitized native Claude 2.1.274 / Codex 0.154.0 post-trust captures (C-TRUST-01).
 * Source: existing real PTY probes; blank rows and trailing padding removed. */
import { claudeTrustClearance } from "../../src/claude/screen-table.ts";
import { codexTrustClearance } from "../../src/codex/screen-table.ts";
import type { ElwoodAgentKind } from "../../src/core/activity/index.ts";
import type { TrustClearance } from "../../src/core/trust/clearance.ts";

export const claudeComposer =
  ' ▐▛███▛█   Claude Code v2.1.274\n▝▜██████▀  Fable 5.1 with high effort · Claude Max\n  ▝▝ ▝▝    /tmp/elwood-native-CAPTURE/project\n                                                                                                                                                                           ● high · /effort\n─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n❯ Try "fix typecheck errors"\n─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n  -- INSERT -- ⏵⏵ don\'t ask on (shift+tab to cycle) · ← for agents';

export const codexComposer =
  "╭──────────────────────────────────────────────────────────╮\n│ >_ OpenAI Codex (v0.154.0)                               │\n│                                                          │\n│ model:     gpt-6-astra   /model to change                │\n│ directory: /private/…/elwood-native-codex-CAPTURE/project │\n╰──────────────────────────────────────────────────────────╯\n  Tip: This is GPT-6, a new generation of intelligence. Astra is state-of-the-art in coding,\n  computer use, science, and professional work. Give it a hard problem, a half-formed idea, or\n  anything you've been meaning to build. See where it takes you.\n⚠ 1 MCP startup issue · ctrl + t for details\n› Ask Codex to do anything\n  gpt-6-astra default · /private/tmp/elwood-native-codex-CAPTURE/project";

/** Real Codex 0.154.0 ready session resized to 100×6, without a model turn. */
export const codexSmallComposer =
  "Tip: New Use /fast to enable our fastest inference with increased plan usage.\n \n \n› Ask Codex to do anything\n \n  gpt-5.6-sol low · /tmp/elwood-composer-CAPTURE/p…";

/** Complete native header+body regions; a bare header is hold-only (C-TRUST-01), so
 * answerable fixtures append option rows. Claude copy: 2.1.252; Codex: 0.154.0. */
export const claudeBody =
  "(Like your own code, a well-known open source project, or work from your\nteam). If not, take a moment to review what's in this folder first.\nClaude Code'll be able to read, edit, and execute files here.\nSecurity guide";
export const claudeTrust = `Do you trust this folder?\n${claudeBody}`;
export const codexTrust =
  "Do you trust the contents of this directory? Working with untrusted contents\ncomes with higher risk of prompt injection. Trusting the directory allows\nproject-local config, hooks, and exec policies to load.";
export const codexHooks =
  "Hooks need review\n1 hook is new or changed.\nHooks can run outside the sandbox after you trust them.";
/** PTY writes need carriage returns; frames handed straight to a parser do not. */
export const tty = (frame: string): string => frame.replaceAll("\n", "\r\n");

/**
 * Each adapter's own clearance grammar, as production injects it (C-TRUST-01). Tests
 * that sweep both agents resolve it here so no test re-encodes a CLI's layout.
 */
export const clearanceFor = (agent: ElwoodAgentKind): TrustClearance =>
  agent === "codex" ? codexTrustClearance : claudeTrustClearance;

/** Native Codex idle captures show its input cursor at column two (C-TRUST-01). */
export function codexTty(frame: string, visible = true): string {
  const row = frame.split("\n").findLastIndex((line) => line.startsWith("›"));
  return `${tty(frame)}\u001b[${row + 1};3H\u001b[?25${visible ? "h" : "l"}`;
}

/** Claude classic renderer restores its native input cursor after the complete paint. */
export function claudeTty(frame: string, visible = true): string {
  const row = frame.split("\n").findLastIndex((line) => line.startsWith("❯"));
  return `${tty(frame)}\u001b[${row + 1};3H\u001b[?25${visible ? "h" : "l"}`;
}
