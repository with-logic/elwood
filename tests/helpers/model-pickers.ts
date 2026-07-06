/**
 * Model picker screen fixtures captured from real CLI sessions (2026-07).
 * Supports C-API-23 and C-API-24 tests.
 */

export const claudePicker = [
  "   Select model",
  "   Switch between Claude models. Your pick becomes the default for new sessions.",
  "     1. Default (recommended)  Opus 4.8 with 1M context · Best for everyday, complex tasks",
  "     2. Opus                   Opus 4.8 with 1M context · Best for everyday, complex tasks",
  "   ❯ 3. Fable ✔                Fable 5 · Most capable for your hardest and longest-running tasks",
  "     4. Sonnet                 Sonnet 5 · Efficient for routine tasks",
  "     5. Haiku                  Haiku 4.5 · Fastest for quick answers",
  "   Enter to set as default · s to use this session only · Esc to cancel",
].join("\n");

export const claudePickerCursorOnHaiku = claudePicker
  .replace("   ❯ 3. Fable ✔ ", "     3. Fable ✔ ")
  .replace("     5. Haiku ", "   ❯ 5. Haiku ");

export const codexPickerCurrentIsDefault = [
  "  Select Model and Effort",
  "  Access legacy models by running codex -m <model_name> or in your config.toml",
  "› 1. gpt-5.5 (current)    Frontier model for complex coding, research, and real-world work.",
  "  2. gpt-5.4              Strong model for everyday coding.",
  "  3. gpt-5.4-mini         Small, fast, and cost-efficient model for simpler coding tasks.",
  "  4. gpt-5.3-codex-spark  Ultra-fast coding model.",
  "  Press enter to confirm or esc to go back",
].join("\n");

export const codexPickerSplitMarkers = [
  "• Model changed to gpt-5.4 medium",
  "  Select Model and Effort",
  "  Access legacy models by running codex -m <model_name> or in your config.toml",
  "  1. gpt-5.5 (default)    Frontier model for complex coding, research, and real-world work.",
  "› 2. gpt-5.4 (current)    Strong model for everyday coding.",
  "  3. gpt-5.4-mini         Small, fast, and cost-efficient model for simpler coding tasks.",
  "  4. gpt-5.3-codex-spark  Ultra-fast coding model.",
  "  Press enter to confirm or esc to go back",
].join("\n");

export const codexReasoningScreen = [
  "  Select Reasoning Level for gpt-5.4",
  "  1. Low               Fast responses with lighter reasoning",
  "› 2. Medium (default)  Balances speed and reasoning depth for everyday tasks",
  "  3. High              Greater reasoning depth for complex problems",
  "  Press enter to confirm or esc to go back",
].join("\n");

/** Renders fixture text as a fresh screen through a raw PTY data stream. */
export function asScreen(text: string): string {
  return `\u001b[2J\u001b[H${text.replaceAll("\n", "\r\n")}`;
}
