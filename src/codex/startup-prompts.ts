/**
 * Handles known Codex startup prompts that block interactive sessions.
 * Implements PRD §4.4, §5.5, and §5.7.
 */

import type { SettledStartupOutcome } from "../core/startup/write.ts";
import { numberedOptions } from "../core/terminal-options.ts";
import { unknownGateVisible } from "../core/trust/blocking.ts";
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
  private skippedUpdate: boolean;
  // The banner identities that fired a warning on the PREVIOUS frame. A warning fires
  // only on the EDGE a banner first appears; a banner still present next frame is NOT
  // re-emitted (that would replay the same live incident indefinitely, C-API-14). A
  // banner that clears (drops out of this set) and reappears fires again — a genuinely
  // new occurrence, matching "once when observed" rather than "replay while on screen".
  private warnedBanners = new Set<string>();

  constructor(elwoodSessionId = "", autotrust = false, onStateChange?: () => void) {
    this.elwoodSessionId = elwoodSessionId;
    this.buffer = "";
    // Owns the whole allowlisted trust family (directory + hook trust), not just
    // one prompt; extended by adding entries to trustPromptAllowlist.
    this.trust = new TrustPromptResponder("codex", autotrust, onStateChange);
    this.skippedUpdate = false;
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

  handle(
    screenText: string,
    write: (input: string) => TrustWriteResult,
    readFrame?: () => string,
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
    // `skippedUpdate` latches after a successful skip so a persistent update screen is
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
    if (!onUpdateScreen) this.skippedUpdate = false;
    // An off-allowlist gate is hold-only even when its rows resemble the update options.
    const unheld = (frame: string) => !unknownGateVisible(frame, "codex");
    if (onUpdateScreen && !this.skippedUpdate && unheld(screenText)) {
      const option = findNumberedOption(this.buffer, codexUpdateOptionPattern);
      if (option) {
        // Settle OPTIMISTICALLY but keep the skip retryable if the write is
        // rejected, so a later frame re-attempts it rather than falsely reporting
        // the update as skipped (C-CODEX-17).
        this.skippedUpdate = true;
        const sameUpdate = this.updatePrompt.currentFramePredicate();
        const settled = writeCodexUpdateSkip(
          option,
          write,
          readFrame,
          (frame) => sameUpdate(frame) && unheld(frame),
        ).then(
          (completion) => {
            if (completion === "cancelled") this.skippedUpdate = false;
            return completion;
          },
          (error: unknown) => {
            this.skippedUpdate = false;
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
  private newWarnings(screenText: string): readonly ElwoodWarningEvent[] {
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
