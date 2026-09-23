/** Handles known Codex startup prompts that block interactive sessions.
 * Implements PRD §4.4, §5.5, and §5.7. */

import type { AutomationWriteResult } from "../core/startup/barrier.ts";
import type { SettledStartupOutcome } from "../core/startup/write.ts";
import { numberedOptions } from "../core/terminal-options.ts";
import { trustGateVisible } from "../core/trust/blocking.ts";
import type { TrustClearance } from "../core/trust/clearance.ts";
import { TrustPromptResponder, type TrustWriteResult } from "../core/trust/responder.ts";
import type { ElwoodWarningEvent } from "../core/types.ts";
import { codexTrustClearance } from "./screen-table.ts";
import { type CodexBannerWarning, codexWarningsFromText } from "./startup-warnings.ts";
import { safeUpdateOption } from "./update/selection.ts";
import { startCodexUpdateSkip } from "./update/skip-attempt.ts";
import { CodexUpdatePromptTracker } from "./update/tracker.ts";

export { codexWarningsFromText } from "./startup-warnings.ts";

/** A Codex startup outcome paired with its PTY-write completion (§5.4, §5.7). */
export type SettledCodexStartupOutcome = SettledStartupOutcome<"codex">;

type CodexStartupPromptResult = {
  readonly warnings: readonly ElwoodWarningEvent[];
  readonly outcomes: readonly SettledCodexStartupOutcome[];
};

export class CodexStartupPromptResponder {
  private readonly elwoodSessionId: string;
  private readonly trust: TrustPromptResponder<"codex">;
  private readonly clearance: TrustClearance;
  private readonly sessionInputHeld: () => boolean;
  private readonly updatePrompt = new CodexUpdatePromptTracker();
  private readonly lifetime = new AbortController();
  // The update-screen generation that owns the skip latch (0 = none). Only that
  // generation's own completion may release it; a stale completion is a no-op.
  private skipGeneration = 0;
  private updateAttempt: ReturnType<typeof startCodexUpdateSkip> | undefined;
  // Emit only newly appearing warning banners; clearing re-arms a later occurrence.
  private warnedBanners = new Set<string>();
  private conversationStarted = false;

  constructor(
    elwoodSessionId = "",
    autotrust = false,
    onStateChange?: () => void,
    clearance: TrustClearance = codexTrustClearance,
    sessionInputHeld: () => boolean = () => false,
  ) {
    this.elwoodSessionId = elwoodSessionId;
    this.clearance = clearance;
    this.sessionInputHeld = sessionInputHeld;
    this.trust = new TrustPromptResponder("codex", clearance, autotrust, onStateChange);
  }

  observeClearance(frame: string): void {
    this.updateAttempt?.observeClearance(frame);
  }

  get closingSignal(): AbortSignal {
    return this.lifetime.signal;
  }

  get blockedPrompt() {
    return this.trust.blockedPrompt;
  }

  dispose(): void {
    this.lifetime.abort();
    this.trust.dispose();
  }

  get inputBlocking(): boolean {
    return this.trust.inputBlocking;
  }

  /**
   * `write` answers trust; `writeAutomation` (default `write`) handles other prompts,
   * where a trust gate must withhold unrelated automated keys.
   * Live adapters must supply `readTrustFrame` from `currentRenderedFrame`, returning
   * undefined for pending rendering, synchronized output, or render failure.
   * The fallback to `readFrame` preserves static/direct callers; a snapshot-only
   * reader must not replace the settlement-aware reader in a live session.
   */
  handle(
    screenText: string,
    write: (input: string) => TrustWriteResult,
    readFrame?: () => string,
    writeAutomation: (input: string) => TrustWriteResult | Promise<AutomationWriteResult> = write,
    readTrustFrame?: () => string | undefined,
  ): CodexStartupPromptResult {
    const outcomes: SettledCodexStartupOutcome[] = [];
    if (this.lifetime.signal.aborted) return { warnings: [], outcomes };
    // Trust prompts are matched against the CURRENT frame only: a stale phrase in
    // an earlier frame must never pair with a different dialog's answer.
    const trust = this.trust.handle(screenText, write, readTrustFrame ?? readFrame);
    if (trust?.kind === "attempted") {
      outcomes.push({
        outcome: { kind: "attempted", ...trust.automation },
        settled: trust.settled,
      });
    } else if (trust?.kind === "option_pending") {
      outcomes.push({ outcome: { kind: "option_pending", prompt: trust.prompt } });
    }
    // The skip is EDGE-triggered and scoped to the CURRENT frame's update screen:
    // `skipGeneration` latches one bounded attempt per appearance so a persistent screen is
    // not re-answered every frame, but it RE-ARMS the moment the update screen leaves
    // the frame. That breaks the observed restart loop — Codex restarts itself, the
    // update does not take, and the SAME update screen reappears; a cleared frame
    // between the two appearances (Codex's restart draws a normal composer) re-arms us
    // to skip the reappearance. Gating the attempt on the CURRENT frame (not just the
    // accumulated buffer) also means a re-armed benign frame that merely mentions
    // "update" never re-fires a skip against a stale buffered option — only a frame
    // actually showing the update screen does. Select only from this frame; the tracker
    // retains split-banner provenance without retaining obsolete option numbers.
    const onUpdateScreen = this.updatePrompt.observe(screenText);
    const generation = this.updatePrompt.currentGeneration;
    // A trust gate (held allowlisted candidate or off-allowlist) is never ELIGIBLE for
    // update-skip automation, even when its rows resemble the update options. Note this
    // gates the WRITE only: `updatePrompt.observe` above still tracks such a frame as an
    // update appearance, so generation latching and re-arming are unaffected.
    const noTrustGate = (frame: string) => !trustGateVisible(frame, "codex");
    if (onUpdateScreen && this.skipGeneration !== generation && noTrustGate(screenText)) {
      const option = safeUpdateOption(screenText)?.number ?? null;
      if (option) {
        // Latch this appearance before writing; rejection can release the latch
        // for a later frame, while success requires observed clearance (C-CODEX-17).
        this.skipGeneration = generation;
        this.updateAttempt = startCodexUpdateSkip({
          option,
          generation,
          screenText,
          tracker: this.updatePrompt,
          writeAutomation,
          readFrame,
          signal: this.lifetime.signal,
          clearance: this.clearance,
          inputHeld: this.sessionInputHeld,
          releaseLatch: () => {
            this.skipGeneration = 0;
          },
        });
        outcomes.push({
          outcome: { kind: "attempted", prompt: "update", input: option },
          settled: this.updateAttempt.settled,
        });
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
