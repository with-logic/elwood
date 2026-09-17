/**
 * A model dialog is live only when its whole native block renders, so a quoted header
 * or a fragment cannot be driven (PRD §5.3, C-API-24).
 */
import { expect, test } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { codexModelPicker } from "../../src/codex/model-picker.ts";
import type { ModelDialogAuthority } from "../../src/core/models/rows.ts";

/** Elwood opened this dialog: the authority every recognition call must carry. */
const opened: ModelDialogAuthority = { opened: true };

const claudeFooter = "   Enter to set as default · s to use this session only · Esc to cancel";
/** A reply quoting the warning: the dialog's own rows stay indented under its title. */
const quotedCacheWarning = [
  "⏺ It shows:",
  "  Switch model?",
  "  Your next response will be slower and use more tokens",
  "  This conversation is cached for the current model. Switching to Fable means the full history gets re-read on your next message.",
] as const;

test.each([
  [
    "a quoted header above a partial trust prompt",
    claudeModelPicker,
    "   Select model\n\nDo you trust the files in this folder?",
  ],
  [
    "a quoted header above a partial hook confirmation",
    claudeModelPicker,
    "   Select model\n\nSwitch model?\nA PreModelSwitch hook asked you to confirm",
  ],
  [
    "a reply's numbered list under a quoted header",
    claudeModelPicker,
    "   Select model\n   1. First step  do this\n   2. Second step  do that",
  ],
  [
    "a picker-shaped Codex composer row under a quoted header",
    codexModelPicker,
    "  Select Model and Effort\n› 1. gpt-5.5  described like a row",
  ],
  [
    "a numbered composer row containing the phrase",
    claudeModelPicker,
    "❯ 1. Select model  and then continue",
  ],
  [
    "a picker with rows and cursor but no footer yet",
    claudeModelPicker,
    "   Select model\n   ❯ 1. Default  Opus\n     2. Haiku  Fast",
  ],
  [
    "a quoted cache warning whose affirmative is the staged composer row",
    claudeModelPicker,
    [...quotedCacheWarning, "    No, go back", "❯ Yes, switch to Fable"].join("\n"),
  ],
  [
    "a quoted cache warning with only a staged affirmative below it",
    claudeModelPicker,
    [...quotedCacheWarning, "❯ Yes, switch to Fable"].join("\n"),
  ],
  [
    // The title itself sits at column zero here, so no indentation test can catch it.
    "an UNINDENTED quoted cache warning above a staged composer action",
    claudeModelPicker,
    [
      "⏺ It shows:",
      "Switch model?",
      "Your next response will be slower and use more tokens",
      "This conversation is cached for the current model. Switching to Fable means the full history gets re-read on your next message.",
      "  No, go back",
      "❯ Yes, switch to Fable",
    ].join("\n"),
  ],
  [
    "a COMPLETE quoted picker above a live trust prompt",
    claudeModelPicker,
    [
      "   Select model",
      "   ❯ 1. Default  Opus",
      "     2. Haiku  Fast",
      claudeFooter,
      "",
      "Do you trust the files in this folder?",
    ].join("\n"),
  ],
  [
    "a numbered composer draft that satisfies the picker grammar",
    claudeModelPicker,
    "❯ 1. Select model  draft\n  2. next  text\n  Esc to cancel",
  ],
  [
    "a reply-prefixed header the agent is merely talking about",
    claudeModelPicker,
    ["⏺ Select model", "   ❯ 1. A  x", "     2. B  y", claudeFooter].join("\n"),
  ],
  [
    "a Codex reply-prefixed header",
    codexModelPicker,
    [
      "• Select Model and Effort",
      "› 1. A  x",
      "  2. B  y",
      "  Press enter to confirm or esc to go back",
    ].join("\n"),
  ],
  [
    "numbered rows with no model-dialog header at all",
    claudeModelPicker,
    ["Do you want to proceed?", "   ❯ 1. A  x", "     2. B  y", claudeFooter].join("\n"),
  ],
  [
    "prose interrupting the picker's own row block",
    claudeModelPicker,
    ["   Select model", "   ❯ 1. A  x", "   some prose here", "     2. B  y", claudeFooter].join(
      "\n",
    ),
  ],
  [
    "the footer phrase buried in a sentence rather than its own hint row",
    claudeModelPicker,
    [
      "   Select model",
      "   ❯ 1. A  x",
      "     2. B  y",
      "   You can press esc to cancel the operation if you want, then retry later.",
    ].join("\n"),
  ],
  [
    "a fully quoted cache warning with a staged action below it",
    claudeModelPicker,
    [
      "⏺ It shows:",
      ...quotedCacheWarning.slice(1),
      "  ❯ 1. Yes, switch to Fable",
      "    2. No, go back",
      "",
      "❯ Yes, switch to Fable",
    ].join("\n"),
  ],
  [
    "a second numbered list that restarts the numbering",
    claudeModelPicker,
    ["   Select model", "   ❯ 1. A  x", "     2. B  y", "     1. C  z", claudeFooter].join("\n"),
  ],
  [
    "a numbered row without the description column",
    claudeModelPicker,
    ["   Select model", "   ❯ 1. A  x", "     2. B  y", "     3. Bare", claudeFooter].join("\n"),
  ],
] as const)("C-API-24 %s is not a complete native dialog", (_name, spec, text) => {
  expect(spec.activeDialog(text, opened)).toBeUndefined();
});
