/** Replay the captured Claude workspace disclosure with a test-specific cwd (C-ATTN-07). */
import { tty } from "../fixtures/trust-composer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";

export function trustFrame(cwd: string): string {
  const menu = capturedFrame("claude-2.1.310/folder-trust-no").trimEnd();
  return `\x1b[2J\x1b[H${tty(menu.replace("/tmp/ELWOOD_CAPTURE/project", cwd))}`;
}
