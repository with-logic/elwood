/**
 * Public option types for the Claude `/login` recovery flow (PRD §5.3, C-API-43).
 */

/** Which login method to pick from the "Select login method" list. */
export type ClaudeLoginMethod = "claudeai" | "console" | "third_party";

export type ClaudeLoginOptions = {
  /**
   * Which method to select if the "Select login method" list renders. Defaults
   * to `claudeai` (the Claude subscription account). If the list never renders
   * (the CLI went straight to authorizing), the selection is skipped.
   */
  readonly method?: ClaudeLoginMethod;
  /**
   * Called with the browser authorization URL once it is scraped off screen, so
   * the caller can open/show it. Optional — the URL is best-effort and a flow
   * that never prints one simply never invokes this.
   */
  readonly onAuthUrl?: (url: string) => void;
  /**
   * REQUIRED for the default account flow: called when the CLI reaches its
   * "paste code here" prompt. The returned authorization code (from the browser
   * success page) is submitted to the terminal. A flow that self-completes
   * without a code prompt never calls this.
   */
  readonly provideCode: () => string | Promise<string>;
  /** Bounds the whole flow; defaults to 300000 ms. */
  readonly timeoutMs?: number;
};

/** Zero-based row index each method occupies in the "Select login method" list. */
export const loginMethodRow: Readonly<Record<ClaudeLoginMethod, number>> = {
  claudeai: 0,
  console: 1,
  third_party: 2,
};

export const defaultLoginTimeoutMs = 300_000;
