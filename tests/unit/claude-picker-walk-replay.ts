/**
 * Replays of key-by-key walks captured from the real Claude 2.1.310 picker, for the window
 * walk tests (PRD §5.3, C-API-23, C-API-24).
 */
import { type CapturedWalk, capturedFrame, capturedWalk } from "../helpers/captured-frames.ts";
import { type ScriptedTerminal, scripted } from "./scripted-terminal.ts";

export const down = "\u001b[B";
export const up = "\u001b[A";
export const escapeKey = "\u001b";
export const fromTop = capturedWalk("claude-2.1.310/model-picker/walk-down-from-top");
export const openedScrolled = capturedWalk("claude-2.1.310/model-picker/walk-opened-scrolled");

/** The 13 models of the captured account, in picker order. */
export const catalog = [
  "default",
  "claude-opus-5-5",
  "claude-fable-5-1",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-haiku-4-5",
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
];

/**
 * Paints, for each key the capture expects next, the frame the real CLI painted after it.
 * Any other key leaves the frame as it is, so a wrong walk stalls instead of passing.
 * Escape and the session-only `s` close the picker.
 */
export function replay(walk: CapturedWalk): ScriptedTerminal {
  const terminal = scripted(walk.opening);
  let next = 0;
  terminal.onInput = (input) => {
    const step = walk.steps[next];
    if (input === step?.key) {
      terminal.text = step.frame;
      next += 1;
    } else if (input === escapeKey || input === "s") terminal.text = "❯ ";
  };
  return terminal;
}

export const io = (terminal: ScriptedTerminal, signal?: AbortSignal) => ({
  terminal,
  submit: () => Promise.resolve(),
  ...(signal === undefined ? {} : { signal }),
});

export const topWindow = capturedFrame("claude-2.1.310/model-picker/top-window");
