/**
 * Model picker screen fixtures captured from real CLI sessions (2026-07), plus the
 * polling helpers the picker-driving tests share (`until`, `flushTerminal`).
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

export const claudeModelCacheConfirmationOnNo = [
  "Switch model?",
  "Your next response will be slower and use more tokens",
  "This conversation is cached for the current model. Switching to Haiku means the full history",
  "gets re-read on your next message.",
  "  Yes, switch to Haiku",
  "❯ No, go back",
].join("\n");

export const claudeModelCacheConfirmationOnYes = claudeModelCacheConfirmationOnNo
  .replace("  Yes, switch to Haiku", "❯ Yes, switch to Haiku")
  .replace("❯ No, go back", "  No, go back");

export const claudeModelCacheConfirmationYesBelow = claudeModelCacheConfirmationOnNo.replace(
  "  Yes, switch to Haiku\n❯ No, go back",
  "❯ No, go back\n  Yes, switch to Haiku",
);

export const claudeModelCacheConfirmationYesBelowSelected = claudeModelCacheConfirmationYesBelow
  .replace("❯ No, go back", "  No, go back")
  .replace("  Yes, switch to Haiku", "❯ Yes, switch to Haiku");

export const claudeEffortCacheConfirmation = [
  "Change effort level?",
  "Your next response will be slower and use more tokens",
  "This conversation is cached for the current effort level. Switching to high means the full",
  "history gets re-read on your next message.",
  "› 1. Yes, switch to xhigh",
  "  2. No, go back",
].join("\n");

export const claudeHookSwitchConfirmation = [
  "Switch model?",
  "A PreModelSwitch hook asked you to confirm",
  "› 1. Yes, switch to Opus",
  "  2. No, go back",
].join("\n");

export const claudeHookSwitchConfirmationWithCacheReason = [
  "Switch model?",
  "A PreModelSwitch hook asked you to confirm",
  "Your next response will be slower and use more tokens",
  "This conversation is cached for the current model. Switching to Opus means the full history",
  "gets re-read on your next message.",
  "› 1. Yes, switch to Opus",
  "  2. No, go back",
].join("\n");

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

export type UntilOptions = {
  /** Poll attempts before giving up (default 800 × 25 ms = 20 s). */
  readonly attempts?: number;
  readonly intervalMs?: number;
  /** Names the awaited state in the timeout error. */
  readonly label?: string;
};

/**
 * Polls `check` without `expect` so it can live in a shared helper. The default budget
 * is generous (20 s) so heavy parallel-suite CPU contention cannot exhaust the poll
 * before the fake PTY emits — the driven operations use a matching large timeoutMs, so
 * neither the op nor this wait loses the race under load.
 */
export async function until(check: () => boolean, options: UntilOptions = {}): Promise<void> {
  const { attempts = 800, intervalMs = 25, label = "picker flow condition" } = options;
  for (let i = 0; i < attempts; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${label} not reached`);
}

/** Yields long enough for the headless terminal to ingest emitted PTY data. */
export function flushTerminal(ms = 25): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
