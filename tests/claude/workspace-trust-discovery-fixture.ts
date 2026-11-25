/** Replay the captured Claude workspace disclosure with a test-specific cwd (C-ATTN-07). */
import { tty } from "../fixtures/trust-composer.ts";
import { claudeWorkspaceTrustScreen } from "../helpers/claude-workspace-trust-screen.ts";

export function trustFrame(cwd: string): string {
  return `\x1b[2J\x1b[H${tty(claudeWorkspaceTrustScreen(cwd))}`;
}
