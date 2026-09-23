/** Codex native hook/activity prompt identity (PRD §5.8, C-API-48; CLI 0.156.1). */
import { sanitizePasteText } from "../core/input/index.ts";

/** Match submitted text only; raw caller input and hook payloads remain unchanged. */
export function codexSubmittedPrompt(prompt: string): string {
  return sanitizePasteText(prompt).replace(/\r\n?/g, "\n").trim();
}
