/**
 * Codex session runtime cleanup helpers.
 * Implements PRD §9.3.
 */

import type { ElwoodTerminal } from "../terminal/headless.ts";
import type { CodexTranscriptWatcher } from "./transcript.ts";

type CodexRuntimeBridge = {
  readonly stop: () => Promise<void>;
};

export async function stopCodexRuntime(
  bridge: CodexRuntimeBridge,
  transcriptWatcher: CodexTranscriptWatcher | undefined,
  terminal: ElwoodTerminal,
): Promise<void> {
  await bridge.stop();
  transcriptWatcher?.flush();
  transcriptWatcher?.stop();
  terminal.dispose();
}
