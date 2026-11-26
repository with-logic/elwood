/**
 * The raw key a host answers each Claude 2.1.332 first-launch screen with, by the screen's
 * own text (PRD §5.4, C-E2E-30). The offer to change the terminal's own settings edits the
 * user's real terminal configuration when accepted, so it is skipped with Esc, and it is
 * matched first: a frame that still shows an earlier screen's text with it gets Esc, never
 * Enter. A screen not listed here gets no key.
 */

/** Enter, or Esc. Nothing else is ever sent to a real first-launch screen. */
export type FirstLaunchKey = "\r" | "\u001b";

const answers: readonly { readonly screen: RegExp; readonly key: FirstLaunchKey }[] = [
  // Esc skips the offer to change the terminal's settings ("Esc to skip").
  { screen: /Use Claude Code's terminal setup\?/u, key: "\u001b" },
  { screen: /Choose the text style/u, key: "\r" },
  { screen: /Security notes:[\s\S]*Press Enter to continue/u, key: "\r" },
];

export function firstLaunchKey(screen: string): FirstLaunchKey | undefined {
  return answers.find((answer) => answer.screen.test(screen))?.key;
}
