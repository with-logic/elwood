/**
 * The permission mode in Claude's footer is read only from the row under the composer's
 * bottom rule, idle or working, never from transcript text that quotes a mode (C-ATTN-10,
 * PRD §5.3).
 */
import { expect, test } from "vitest";
import { claudeFooterMode } from "../../src/claude/composer/footer.ts";
import { offerText, workingText } from "../fixtures/offer-frames.ts";

const rule = "─".repeat(40);

test.each([
  { screen: "the captured offer's idle footer", text: offerText, mode: "⏵⏵ auto mode on" },
  { screen: "its working footer", text: workingText, mode: "⏵⏵ auto mode on" },
  {
    screen: "vim insert mode",
    text: [rule, "❯", rule, "  -- INSERT -- ⏸ manual mode on · ? for shortcuts"].join("\n"),
    mode: "⏸ manual mode on",
  },
  {
    screen: "a quote above another mode's footer",
    text: ["⏵⏵ auto mode on", rule, "❯", rule, "  ⏵⏵ accept edits on"].join("\n"),
    mode: "⏵⏵ accept edits on",
  },
  { screen: "a quote with no composer", text: "  ⏵⏵ auto mode on", mode: undefined },
  { screen: "a bottom rule on the last row", text: ["❯", rule].join("\n"), mode: undefined },
  {
    screen: "a mode quoted inside the footer row",
    text: [rule, "❯", rule, "  esc ⏵⏵ auto mode on"].join("\n"),
    mode: undefined,
  },
  {
    screen: "a longer word after the mode",
    text: [rule, "❯", rule, "  ⏵⏵ auto mode online"].join("\n"),
    mode: undefined,
  },
])("C-ATTN-10 the footer mode for $screen is $mode", ({ text, mode }) => {
  expect(claudeFooterMode(text)).toBe(mode);
});
