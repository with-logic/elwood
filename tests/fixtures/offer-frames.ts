/**
 * Screens around Claude 2.1.332's auto-mode setup offer, built from its 140x40 capture, for
 * the C-ATTN-09 and C-ATTN-10 session tests (PRD §5.3): the offer itself, the same screen
 * with the offer rows blank (idle) or working, and another dialog in the offer's place.
 */
import { capturedFrame } from "../helpers/captured-frames.ts";
import { readNativeInputFrame } from "./native-input-frame.ts";
import { tty } from "./trust-composer.ts";

const offerRows = capturedFrame("claude-2.1.332/auto-mode-offer").trimEnd().split("\n");
/** The offer spans its top rule, the row above its title, through its key hint row. */
const offerTop = offerRows.findIndex((row) => row.includes("Teach auto mode about")) - 1;
const offerEnd = offerRows.findIndex((row) => row.includes("Esc to cancel")) + 1;

/** The captured offer frame's text. */
export const offerText = offerRows.join("\n");
/** The captured offer frame without the offer: the composer and footer it painted over. */
export const idleText = [
  ...offerRows.slice(0, offerTop),
  ...offerRows.slice(offerTop, offerEnd).map(() => ""),
  ...offerRows.slice(offerEnd),
].join("\n");
/** That idle screen while a turn works, as its footer shows. */
export const workingText = idleText.replace(
  "auto mode on (shift+tab to cycle)",
  "auto mode on (shift+tab to cycle) · esc to interrupt",
);

/** The rows of the captured 2.1.310 permission dialog, cut to the offer frame's 140 columns. */
const permissionRows = readNativeInputFrame(
  new URL("claude-2.1.310/permission-declined/dialog.json", import.meta.url),
)
  .text.trimEnd()
  .split("\n")
  .slice(-12)
  .map((row) => row.slice(0, 140));
/** Another Claude dialog in the rows that end where the offer ends, above the same composer. */
const dialogTop = offerEnd - permissionRows.length;
export const permissionText = [
  ...offerRows.slice(0, dialogTop),
  ...permissionRows,
  ...offerRows.slice(offerEnd),
].join("\n");

/** A whole repaint of `text`, then the hardware cursor at `cursor` (CSI row;col H). */
export function offerScreen(text: string, cursor = "\u001b[38;3H"): string {
  return `\u001b[2J\u001b[H${tty(text)}${cursor}`;
}

/** The idle screen with Claude's cursor shown in its composer. */
export const idleScreen = offerScreen(idleText, "\u001b[38;3H\u001b[?25h");
/** The offer, with the hardware cursor on its `❯ 1. Yes` row, as Claude leaves it. */
export const offerOnScreen = offerScreen(offerText, "\u001b[32;3H");
/** The permission dialog in the offer's place, with the cursor on its `❯ 1. Yes` row. */
export const permissionScreen = offerScreen(permissionText, "\u001b[34;4H");
