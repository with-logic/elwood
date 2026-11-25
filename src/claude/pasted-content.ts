/** Match Claude's standalone native paste envelope and retain its literal escapes (C-API-67). */
import { createHash } from "node:crypto";
import type { UserPromptPresentation } from "../core/activity/prompt-presentation.ts";
import { hasPromptText } from "../core/activity/prompt-text.ts";

const envelopeIdWidth = 4;
const pasteOpening = new RegExp(
  String.raw`^\n{0,2}<pasted_content id="([0-9a-f]{${envelopeIdWidth}})">\n`,
  "u",
);

/** Claude derives the expected envelope ID from its native session ID (2.1.331–2.1.332). */
export function claudePasteEnvelopeId(nativeSessionId: string): string | undefined {
  if (!hasPromptText(nativeSessionId)) return undefined;
  return createHash("sha256").update(nativeSessionId).digest("hex").slice(0, envelopeIdWidth);
}

function claudePastedBody(prompt: string, envelopeId: string): string | undefined {
  const outer = pasteOpening.exec(prompt);
  if (!outer || outer[1] !== envelopeId) return undefined;
  const opening = outer[0];
  const closing = `\n</pasted_content id="${envelopeId}">`;
  const end = prompt.indexOf(closing, opening.length - 1);
  if (end < 0 || !/^\n{0,2}$/u.test(prompt.slice(end + closing.length))) return undefined;
  const body = prompt.slice(opening.length, end);
  // Claude escapes tag look-alikes inside native paste text. A nested unescaped
  // tag is ambiguous, and an existing escape must stay in the displayed text.
  const unescapedTag = /<(?=[^A-Za-z0-9_\\<>-]*pasted[_-]content(?:[^A-Za-z0-9_-]|$))/iu;
  return hasPromptText(body) && !unescapedTag.test(body) ? body : undefined;
}

/**
 * Unwrap a standalone paste matching the expected session-derived envelope ID.
 * Keep the delivered envelope in `nativePrompt` on a match. Otherwise keep the delivered text.
 */
export function claudePromptPresentation(
  prompt: string,
  envelopeId: string | undefined,
): UserPromptPresentation {
  const body = envelopeId === undefined ? undefined : claudePastedBody(prompt, envelopeId);
  return body === undefined
    ? { text: prompt }
    : {
        text: body,
        nativePrompt: prompt,
        promptProvenance: { origin: "unknown", input: "pasted" },
      };
}

const submitPresentations = new WeakMap<object, UserPromptPresentation>();

/**
 * One submit hook's presentation, computed once per hook event. The hook handler projects the
 * event's `user_message` first and turn acceptance reads the same frozen event afterward, so a
 * large prompt is scanned for its envelope once. Both callers pass that event's own prompt and
 * session-derived envelope ID.
 */
export function claudeSubmitPresentation(
  hookEvent: object,
  prompt: string,
  envelopeId: string | undefined,
): UserPromptPresentation {
  const cached = submitPresentations.get(hookEvent);
  if (cached) return cached;
  const presentation = claudePromptPresentation(prompt, envelopeId);
  submitPresentations.set(hookEvent, presentation);
  return presentation;
}
