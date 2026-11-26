/**
 * Recognizes a frame a CLI draws while it loads: its own header and nothing a person could
 * answer. Such a frame is not an unrecognized startup screen (PRD §5.4, C-ATTN-09).
 */

/** A selection caret with text after it, a numbered choice, or a key hint. */
const answerableRow =
  /^\s*[❯›»>]\s*\S|^\s*\d+[.)]\s+\S|\b(?:Enter|Esc|Press|confirm|cancel|continue)\b|\(y\/n\)/i;

/**
 * Whether `frame` shows the agent's `header` and no row besides it that a person could
 * answer. Claude 2.1.310 showed its version banner alone for 4 s after an answered trust
 * prompt on a loaded host, and Codex 0.172.0 drew its header over its logo before its
 * composer (docs/cli-behavior.md).
 */
export function nativeBootFrame(header: RegExp): (frame: string) => boolean {
  return (frame) => {
    const rows = frame.split("\n");
    return (
      rows.some((row) => header.test(row)) &&
      !rows.some((row) => !header.test(row) && answerableRow.test(row))
    );
  };
}
