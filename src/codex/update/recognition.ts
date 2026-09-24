/** Recognizes native update appearances and continuation rows (PRD §5.5, C-CODEX-12). */
import { classifyCodexUpdateFrame } from "./classification.ts";

export { updateScreenBanner } from "./layout.ts";

export function codexUpdatePromptVisible(frameText: string): boolean {
  return classifyCodexUpdateFrame(frameText).visible;
}

export function isSafeUpdateContinuation(frameText: string): boolean {
  return classifyCodexUpdateFrame(frameText).continuation;
}
