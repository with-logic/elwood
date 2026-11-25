/** Replay the captured Claude workspace disclosure at the test's launch path (C-ATTN-07). */
import { capturedFrame } from "./captured-frames.ts";

export function claudeWorkspaceTrustScreen(cwd: string, selected: "yes" | "no" = "no"): string {
  return capturedFrame(`claude-2.1.310/folder-trust-${selected}`)
    .trimEnd()
    .replace("/tmp/ELWOOD_CAPTURE/project", cwd);
}
