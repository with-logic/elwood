/**
 * Screen predicates for the real Claude folder-trust gate: recognizes the
 * allowlisted prompt, wording-drifted variants, and a fully painted option list.
 * Shared by the trust-prompt e2e (PRD §5.1, C-E2E-09).
 */

import { trustPromptAllowlist, trustPromptHeaderVisible } from "../../src/core/trust/prompts.ts";

/** True when an allowlisted trust prompt for `agent` is visible in `text`. */
export function trustPromptVisible(text: string, agent: "claude" | "codex"): boolean {
  return trustPromptAllowlist.some(
    (spec) => spec.agent === agent && trustPromptHeaderVisible(text, spec),
  );
}

/** True for known and wording-drifted variants of Claude's rendered folder-trust screen. */
export function folderTrustScreenVisible(frame: string): boolean {
  return (
    trustPromptVisible(frame, "claude") ||
    (/Accessing workspace:/i.test(frame) && /trust this folder/i.test(frame))
  );
}

/** A complete folder-trust screen whose options have painted, answerable or not. */
export function completeFolderTrustScreenVisible(frame: string): boolean {
  return (
    folderTrustScreenVisible(frame) && /[❯›].*(?:yes|no)/i.test(frame) && /\byes\b/i.test(frame)
  );
}
