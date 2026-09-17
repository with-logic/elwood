/**
 * Allowlist of known adapter startup trust prompts and how to answer them.
 * Implements PRD §5.1 and §5.5 (C-CLAUDE-10, C-CODEX-11, C-CLAUDE-14, C-CODEX-15).
 *
 * This is an EXPLICIT allowlist, not an open-ended matcher: each entry names one
 * concrete prompt by its on-screen text and a fixed affirmative outcome. A new
 * CLI prompt is trusted only by adding a deliberate entry here — Elwood never
 * blanket-answers "any first-run confirmation", which would silently bypass a
 * future CLI security gate for third-party code or config.
 */

import type { ElwoodAgentKind } from "../activity/index.ts";
import { trustPromptAllowlist } from "./allowlist.ts";
import type { TrustDialog } from "./dialog.ts";

export { trustPromptAllowlist } from "./allowlist.ts";

/** Header and affirmative matchers for one active dialog (C-TRUST-01). */
type TrustPromptBase = {
  /** Anchored standalone header, matched only inside an active trust-dialog region. */
  readonly headerPattern: RegExp;
  /** Native copy after the header: required where the prompt has any; unknown prose fails closed. */
  readonly descriptionPattern: RegExp;
  /** Every parsed row must be one of this dialog's native choices, including declines. */
  readonly optionPattern: RegExp;
  /** Matches the exact affirmative option label for THIS prompt (per-prompt, not generic). */
  readonly accept: RegExp;
};

/** The Claude trust-prompt ids: folder trust plus the CLI's first-run skill/plugin/MCP gates. */
type ClaudeTrustPromptId =
  | "workspace_trust"
  | "skill_trust"
  | "plugin_trust"
  | "mcp_trust"
  | "bypass_permissions";

/**
 * When an allowlisted prompt is answered. `"autotrust"` prompts are answered ONLY
 * under the caller's full-trust posture; `"always"` prompts are answered
 * regardless of it (Codex trusts all configured hooks, including third-party hooks).
 */
export type TrustAnswerPolicy = "always" | "autotrust";

/**
 * One allowlisted trust prompt, as an agent+id-DISCRIMINATED union so that (a) a
 * typo in `id` cannot compile into a public startup label, and (b)
 * `answerPolicy: "always"` — answered regardless of `autotrust` — is permitted
 * ONLY on Codex `hook_trust`. Codex hook trust is session-wide, covering Elwood's
 * bridge and every third-party hook. Other trust prompts (skills, plugins, MCP
 * servers, folder trust) remain gated on the caller's full-trust posture.
 */
export type TrustPromptSpec =
  | ({
      readonly agent: "claude";
      readonly id: ClaudeTrustPromptId;
      readonly answerPolicy: "autotrust";
    } & TrustPromptBase)
  | ({
      readonly agent: "codex";
      readonly id: "workspace_trust";
      readonly answerPolicy: "autotrust";
    } & TrustPromptBase)
  | ({
      readonly agent: "codex";
      readonly id: "hook_trust";
      /** Answered regardless of `autotrust`: all configured Codex hooks, including third-party code. */
      readonly answerPolicy: "always";
    } & TrustPromptBase);

/** Match one already-parsed active dialog against its header and native explanation. */
export function activeTrustDialogVisible(
  dialog: TrustDialog | undefined,
  spec: TrustPromptBase,
): boolean {
  if (dialog === undefined) return false;
  const header = spec.headerPattern.exec(dialog.header);
  return (
    header !== null &&
    spec.descriptionPattern.test(dialog.header.slice(header[0].length).trim()) &&
    dialog.options.every((option) => spec.optionPattern.test(option.label))
  );
}

/**
 * The stable public `startup_prompt` trust labels (§5.4), derived from the
 * allowlist so the two can never drift: deleting, adding, or renaming an entry
 * updates this union automatically. Because `TrustPromptSpec` fixes each agent's
 * ids to a closed literal union, a typo in an entry's `id` fails to compile
 * against `satisfies` rather than silently widening this derived label union.
 */
export type TrustPromptId = (typeof trustPromptAllowlist)[number]["id"];

/** The trust label ids for one specific agent (e.g. Codex automation cannot use a Claude-only id). */
export type TrustPromptIdFor<A extends ElwoodAgentKind> = Extract<
  (typeof trustPromptAllowlist)[number],
  { readonly agent: A }
>["id"];

/** Specs for one agent that stay UNANSWERED under the effective policy (block on the human). */
export function blockingTrustSpecs(
  agent: ElwoodAgentKind,
  autotrust: boolean,
): readonly TrustPromptSpec[] {
  return trustPromptAllowlist.filter(
    // Static human rules omit automation-owned prompts. The coordinator separately
    // exposes recoverable human blocking when an owned trust episode expires.
    (spec) => spec.agent === agent && spec.answerPolicy !== "always" && !autotrust,
  );
}
