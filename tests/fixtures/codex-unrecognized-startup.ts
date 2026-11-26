/**
 * A Codex startup screen that no Elwood recognizer matches, for the pre-readiness write
 * hold (PRD §5.3, C-API-28). It keeps the menu layout of Codex 0.171's update offer,
 * whose selected row starts with the `›` composer marker, but its content is invented,
 * standing for whatever screen a future Codex draws before its composer.
 */
export const unrecognizedStartupScreen = [
  "",
  "  Introducing a new startup step",
  "  Learn more: https://example.com/new-step",
  "",
  "› 1. Try it now",
  "  2. Not now",
  "",
  "  enter continue · esc skip",
].join("\n");
