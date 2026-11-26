/** Handle blocking Codex startup prompts (PRD §4.4, §5.5, and §5.7). */
import type { AutomationWriteResult } from "../core/startup/barrier.ts";
import type { SettledStartupOutcome } from "../core/startup/write.ts";
import type { TrustClearance } from "../core/trust/clearance.ts";
import { TrustPromptResponder, type TrustWriteResult } from "../core/trust/responder.ts";
import type { ElwoodWarningEvent } from "../core/types.ts";
import { codexTrustClearance } from "./screen-table.ts";
import { codexBannerKey, codexWarningsFromText } from "./startup-warnings.ts";
import { codexNumberedRetry } from "./trust-retry.ts";
import { CodexUpdateSkips } from "./update/skips.ts";
import type { CodexWorkspaceTrustHooks } from "./workspace-trust/prelude-input.ts";

export { codexWarningsFromText } from "./startup-warnings.ts";
/** A Codex startup outcome paired with its PTY-write completion (§5.4, §5.7). */
export type SettledCodexStartupOutcome = SettledStartupOutcome<"codex">;

type CodexStartupPromptResult = {
  readonly warnings: readonly ElwoodWarningEvent[];
  readonly outcomes: readonly SettledCodexStartupOutcome[];
  readonly updateGeneration?: number;
};

export class CodexStartupPromptResponder {
  private readonly elwoodSessionId: string;
  private readonly trust: TrustPromptResponder<"codex">;
  private readonly workspaceTrust: CodexWorkspaceTrustHooks | undefined;
  private readonly lifetime = new AbortController();
  private readonly updates: CodexUpdateSkips;
  // Emit only newly appearing warning banners; clearing re-arms a later occurrence.
  private warnedBanners = new Set<string>();
  private conversationStarted = false;

  constructor(
    elwoodSessionId = "",
    autotrust = false,
    onStateChange?: () => void,
    clearance: TrustClearance = codexTrustClearance,
    sessionInputHeld?: () => boolean,
    workspaceTrust?: CodexWorkspaceTrustHooks,
  ) {
    this.elwoodSessionId = elwoodSessionId;
    this.workspaceTrust = workspaceTrust;
    this.updates = new CodexUpdateSkips({
      clearance,
      inputHeld: sessionInputHeld,
      signal: this.lifetime.signal,
      onStateChange,
    });
    this.trust = new TrustPromptResponder("codex", clearance, autotrust, {
      onStateChange,
      numberedRetry: codexNumberedRetry,
      claimCallerOwnership: workspaceTrust?.prelude.consumePendingClaim,
    });
  }

  observeClearance(frame: string): void {
    this.updates.observeClearance(frame);
  }

  get closingSignal(): AbortSignal {
    return this.lifetime.signal;
  }

  get blockedPrompt() {
    return this.trust.blockedPrompt;
  }
  get humanOwnedPrompt() {
    return this.trust.humanOwnedPrompt;
  }
  dispose(): void {
    this.lifetime.abort();
    this.trust.dispose();
  }

  /** Raw caller input owns the startup prompt on screen (C-TRUST-01, C-CODEX-12). */
  callerInput(): void {
    const priorPrompt = this.humanOwnedPrompt;
    this.workspaceTrust?.prelude.record();
    this.trust.callerInput();
    this.updates.callerInput();
    const prompt = this.humanOwnedPrompt;
    if (prompt === "workspace_trust" && priorPrompt !== prompt) this.workspaceTrust?.onTakeover();
  }

  /** Trust automation, or Codex's repaint after an update skip, holds input (C-CODEX-27). */
  get inputBlocking(): boolean {
    return this.trust.inputBlocking || this.updates.ownsRepaint();
  }

  /**
   * `write` answers trust. A trust hold withholds `writeAutomation` keys for other prompts.
   * Live adapters must supply `readTrustFrame` from `settledLiveSnapshot`, returning
   * undefined for pending rendering, synchronized output, or render failure.
   * The `readFrame` fallback is for static callers.
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
    const update = this.updates.observe(screenText, writeAutomation, readFrame);
    if (update.outcome) outcomes.push(update.outcome);
    return {
      warnings: this.newWarnings(screenText),
      outcomes,
      ...(update.renewAttention ? { updateGeneration: update.generation } : {}),
    };
  }

  // Key newly visible warnings by semantic identity, independent of terminal
  // padding and wrapping. Removing a banner from the current frame re-arms it
  // for a later appearance (C-API-14, §5.7).
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
    const fresh = matched.filter((warning) => !this.warnedBanners.has(codexBannerKey(warning)));
    this.warnedBanners = new Set(matched.map(codexBannerKey));
    return fresh;
  }
}
