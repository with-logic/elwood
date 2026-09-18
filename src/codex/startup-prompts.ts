/**
 * Handles known Codex startup prompts that block interactive sessions.
 * Implements PRD §4.4, §5.5, and §5.7.
 */

import type { AutomationWriteResult } from "../core/startup/barrier.ts";
import type { SettledStartupOutcome, StartupWriteCompletion } from "../core/startup/write.ts";
import { numberedOptions } from "../core/terminal-options.ts";
import { TrustPromptResponder, type TrustWriteResult } from "../core/trust/responder.ts";
import type { ElwoodWarningEvent } from "../core/types.ts";
import { type CodexBannerWarning, codexWarningsFromText } from "./startup-warnings.ts";

import {
  CodexUpdatePromptTracker,
  codexUpdateOptionPattern,
  writeCodexUpdateSkip,
} from "./update-prompt.ts";

export { codexWarningsFromText } from "./startup-warnings.ts";

/** A Codex startup outcome paired with its PTY-write completion (§5.4, §5.7). */
export type SettledCodexStartupOutcome = SettledStartupOutcome<"codex">;

type CodexStartupPromptResult = {
  readonly warnings: readonly ElwoodWarningEvent[];
  readonly outcomes: readonly SettledCodexStartupOutcome[];
};

const maxBufferLength = 6_000;

export class CodexStartupPromptResponder {
  private buffer: string;
  private readonly elwoodSessionId: string;
  private readonly trust: TrustPromptResponder<"codex">;
  private readonly updatePrompt = new CodexUpdatePromptTracker();
  // The update-screen generation that owns the skip latch (0 = none). Only that
  // generation's own completion may release it; a stale completion is a no-op.
  private skipGeneration = 0;
  // The banner identities that fired a warning on the PREVIOUS frame. A warning fires
  // only on the EDGE a banner first appears; a banner still present next frame is NOT
  // re-emitted (that would replay the same live incident indefinitely, C-API-14). A
  // banner that clears (drops out of this set) and reappears fires again — a genuinely
  // new occurrence, matching "once when observed" rather than "replay while on screen".
  private warnedBanners = new Set<string>();
  private conversationStarted = false;

  constructor(elwoodSessionId = "", autotrust = false, onStateChange?: () => void) {
    this.elwoodSessionId = elwoodSessionId;
    this.buffer = "";
    // Owns the whole allowlisted trust family (directory + hook trust), not just
    // one prompt; extended by adding entries to trustPromptAllowlist.
    this.trust = new TrustPromptResponder("codex", autotrust, onStateChange);
  }

  get blockedPrompt() {
    return this.trust.blockedPrompt;
  }

  dispose(): void {
    this.trust.dispose();
  }

  get inputBlocking(): boolean {
    return this.trust.inputBlocking;
  }

  /**
   * `write` answers TRUST prompts and belongs to `TrustPromptResponder` alone.
   * `writeAutomation` carries every NON-trust automated key (here, the update skip and
   * its retries). They are separate parameters so the two classes of write can be
   * guarded differently — only non-trust automation may be withheld when a trust gate
   * is on screen, since answering such a gate is the trust responder's own job (#42).
   * Defaults to `write`, so a caller that passes one writer keeps today's behavior.
   */
  handle(
    screenText: string,
    write: (input: string) => TrustWriteResult,
    readFrame?: () => string,
    writeAutomation: (input: string) => TrustWriteResult | Promise<AutomationWriteResult> = write,
  ): CodexStartupPromptResult {
    const outcomes: SettledCodexStartupOutcome[] = [];
    this.buffer = `${this.buffer}\n${screenText}`.slice(-maxBufferLength);
    // Trust prompts are matched against the CURRENT frame only: a stale phrase in
    // the accumulated buffer must never pair with a different dialog's answer.
    const trust = this.trust.handle(screenText, write, readFrame);
    if (trust?.kind === "attempted") {
      outcomes.push({
        outcome: { kind: "attempted", ...trust.automation },
        settled: trust.settled,
      });
    } else if (trust?.kind === "option_pending") {
      outcomes.push({ outcome: { kind: "option_pending", prompt: trust.prompt } });
    }
    // Skipping an available update is not a trust decision, so it stays here.
    // The skip is EDGE-triggered and scoped to the CURRENT frame's update screen:
    // `skipGeneration` latches one bounded attempt per appearance so a persistent screen is
    // not re-answered every frame, but it RE-ARMS the moment the update screen leaves
    // the frame. That breaks the observed restart loop — Codex restarts itself, the
    // update does not take, and the SAME update screen reappears; a cleared frame
    // between the two appearances (Codex's restart draws a normal composer) re-arms us
    // to skip the reappearance. Gating the attempt on the CURRENT frame (not just the
    // accumulated buffer) also means a re-armed benign frame that merely mentions
    // "update" never re-fires a skip against a stale buffered option — only a frame
    // actually showing the update screen does. The buffer is still consulted to LOCATE
    // the option, since Codex can split the banner and its numbered options across two
    // consecutive frames.
    const onUpdateScreen = this.updatePrompt.observe(screenText);
    const generation = this.updatePrompt.currentGeneration;
    if (onUpdateScreen && this.skipGeneration !== generation) {
      const option = findNumberedOption(this.buffer, codexUpdateOptionPattern);
      if (option) {
        // Settle OPTIMISTICALLY but keep the skip retryable if the write is
        // rejected, so a later frame re-attempts it rather than falsely reporting
        // the update as skipped (C-CODEX-17).
        this.skipGeneration = generation;
        // A later appearance owns the latch AND the settlement. A write rejected once the
        // screen cleared is quiet too (nothing is left to retry or block on); a clear
        // after our key is what success means (C-CODEX-12).
        const current = this.updatePrompt.currentFramePredicate();
        const settled = writeCodexUpdateSkip(option, writeAutomation, readFrame, current).then(
          (completion) => {
            const replaced = this.updatePrompt.hasLaterAppearance(generation);
            if (completion === "exhausted" || replaced) return "cancelled";
            if (completion === "cancelled") this.skipGeneration = 0;
            return completion;
          },
          (error: unknown): StartupWriteCompletion => {
            const replaced = this.updatePrompt.hasLaterAppearance(generation);
            if (!replaced) this.skipGeneration = 0; // retryable within its own appearance
            // The LIVE frame can clear before handle() sees it; with no reader, the
            // attempt's own frame reduces this to the generation check.
            if (!current(readFrame?.() ?? screenText)) return "cancelled";
            throw error;
          },
        );
        outcomes.push({ outcome: { kind: "attempted", prompt: "update", input: option }, settled });
      }
    }
    return { warnings: this.newWarnings(screenText), outcomes };
  }

  // Emit warnings only for banners NEWLY appearing on THIS frame, matched against the
  // CURRENT frame (not the accumulated buffer) so a scrolled-off banner does not replay
  // every later frame (C-API-14, §5.7). Banners are keyed by a STABLE semantic identity
  // (code + the server(s) it names), not the raw rendered line — the emulator may render
  // the same banner with different padding/wrapping across frames, which raw-line keying
  // would treat as new. `warnedBanners` is reset to this frame's identities, so a banner
  // that clears (leaves the frame) then reappears fires again as a genuinely new occurrence.
  /** The session is about to write caller input; nothing after this is a startup banner. */
  endStartup(): void {
    this.conversationStarted = true;
  }

  private newWarnings(screenText: string): readonly ElwoodWarningEvent[] {
    // Startup banners can only come from startup: once caller content or a resumed
    // transcript can be on screen, a copied welcome box whose own conversation marker
    // has scrolled out of the frame is content, not provenance. EVERY assistant-marker
    // row ends it — no spinner exemption, since a message can quote spinner text and
    // native Codex 0.154.0 startup renders no `•` row at all (docs/cli-behavior.md).
    this.conversationStarted ||= /^\s*[●•]/m.test(screenText);
    if (this.conversationStarted) return [];
    const matched = codexWarningsFromText(screenText, this.elwoodSessionId);
    const fresh = matched.filter((warning) => !this.warnedBanners.has(bannerKey(warning)));
    this.warnedBanners = new Set(matched.map(bannerKey));
    return fresh;
  }
}

/** A stable identity for a startup banner: its code plus the server(s) it names. */
function bannerKey(warning: CodexBannerWarning): string {
  return warning.code === "mcp_server_not_logged_in"
    ? `login:${warning.mcpServerName}`
    : `startup:${warning.failedServers.join(",")}`;
}

export function findNumberedOption(text: string, pattern: RegExp): string | null {
  return numberedOptions(text).find((option) => pattern.test(option.label))?.number ?? null;
}
