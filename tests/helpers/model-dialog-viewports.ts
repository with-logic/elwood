/**
 * Full-viewport model dialog captures from real Claude 2.1.274 and Codex 0.154.0
 * (2026-09-17, paths and rule widths trimmed). Both CLIs replace the composer with
 * the dialog, so nothing but the dialog renders below its header (C-API-24).
 */

export const claudePickerViewport = [
  "❯ /model",
  "",
  "────────────────────────────────────────",
  "  Select model",
  "  Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, specify with --model.",
  "",
  "    1. Default (recommended)  Opus 5 with 1M context · Best for everyday, complex tasks",
  "  ❯ 2. Opus (1M context) ✔    Opus 5 with 1M context · Best for everyday, complex tasks",
  "    3. Fable                  Fable 5.1 · Most capable for your hardest and longest-running tasks",
  "    4. Sonnet                 Sonnet 5 · Efficient for routine tasks",
  "    5. Haiku                  Haiku 4.5 · Fastest for quick answers",
  "",
  "  ◉ xHigh effort ←/→ to adjust",
  "",
  "  Enter to set as default · s to use this session only · Esc to cancel",
].join("\n");

export const claudeClosedPickerViewport = [
  "❯ /model",
  "  ⎿  Kept model as Opus 5 (1M context)",
  "",
  "────────────────────────────────────────",
  "❯",
  "────────────────────────────────────────",
  "  -- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
  "  ◉ xhigh · /effort",
].join("\n");

export const claudeCacheWarningViewport = [
  "⏺ ok",
  "",
  "✻ Brewed for 1s · done 4:16 AM",
  "",
  "❯ /model",
  "",
  "────────────────────────────────────────",
  "  Switch model?",
  "  Your next response will be slower and use more tokens",
  "",
  "  This conversation is cached for the current model. Switching to Fable 5.1 means the full history gets re-read on your next message.",
  "",
  "  ❯ 1. Yes, switch to Fable 5.1",
  "    2. No, go back",
].join("\n");

/**
 * The one frame Claude 2.1.274 rendered between the picker (after `s`) and the complete
 * warning, 28 ms after the key: the title and copy are painted over stale picker rows,
 * and neither `Select model` nor the Yes/No options exist yet.
 */
export const claudeCacheWarningPartialViewport = [
  "⏺ ok",
  "",
  "✻ Brewed for 1s · done 4:16 AM",
  "",
  "❯ /model",
  "",
  "────────────────────────────────────────",
  "  Switch model?",
  "  Your next response will be slower and use more tokens",
  "",
  "  This conversation is cached for the current model. Switching to Fable 5.1 means the full history gets re-read on your next message.",
  "",
  "  ❯ 1. Fable                  Fable 5.1 · Most capable for your hardest and longest-running tasks",
  "    4. Sonnet                 Sonnet 5 · Efficient for routine tasks",
  "    5. Haiku                  Haiku 4.5 · Fastest for quick answers",
].join("\n");

export const codexPickerViewport = [
  "⚠ `--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.",
  "",
  "",
  "  Select Model and Effort",
  "  Access legacy models by running codex -m <model_name> or in your config.toml",
  "",
  "› 1. gpt-6-astra (current)  Our most capable model for complex, demanding work.",
  "  2. gpt-5.6-sol            Reliable agentic workhorse for everyday tasks.",
  "  3. gpt-5.6-terra          Balanced agentic coding model for everyday work.",
  "  4. gpt-5.6-luna           Fast and affordable agentic coding model.",
  "  5. gpt-5.5                Proven previous-generation model for coding and general work.",
  "",
  "  Press enter to confirm or esc to go back",
].join("\n");

export const codexReasoningViewport = [
  "⚠ `--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.",
  "",
  "",
  "  Select Reasoning Level for gpt-6-astra",
  "",
  "  1. Low                         Fast responses with lighter reasoning",
  "› 2. Medium (default) (current)  Balances speed and reasoning depth for everyday tasks",
  "  3. High                        Greater reasoning depth for complex problems",
  "  4. Extra high                  Extra high reasoning depth for complex problems",
  "  5. More reasoning…             Max and Ultra consume usage limits faster",
  "",
  "  Press enter to confirm or esc to go back",
].join("\n");

export const codexClosedPickerViewport = [
  "⚠ `--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.",
  "",
  "",
  "› Ask Codex to do anything",
  "",
  "  gpt-6-astra medium · /tmp/project",
].join("\n");
