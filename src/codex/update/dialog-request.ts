/**
 * Reads Codex's update offer as a public `kind: "update"` dialog request: the banner and
 * the rows before the choices, the version pair, and the choices in native order
 * (PRD §5.13 "Codex update offers", C-ATTN-12).
 */
import { randomUUID } from "node:crypto";
import type { ElwoodUpdateDialogRequest } from "../../core/dialogs/types.ts";
import { updateDialogOptions, updateScreenBanner } from "./layout.ts";

const versionPair = /(\d+\.\d+\.\d+)\s*(?:->|→)\s*(\d+\.\d+\.\d+)/;
/** The first choice row and everything after it. */
const choicesOnward = /^\s*[›>❯]?\s*\d+[.)]\s[\s\S]*/m;

export type CodexUpdateOffer = Pick<ElwoodUpdateDialogRequest, "text" | "versions"> & {
  readonly labels: readonly string[];
};

/** The offer on `frame`, or undefined unless its banner and one valid choice block are drawn. */
export function readCodexUpdateOffer(frame: string): CodexUpdateOffer | undefined {
  const banner = updateScreenBanner.exec(frame);
  const options = updateDialogOptions(frame);
  if (!(banner && options?.length)) return undefined;
  const text = frame.slice(banner.index).replace(choicesOnward, "").replace(/\s+/g, " ").trim();
  const pair = versionPair.exec(banner[0]);
  return {
    text,
    ...(pair ? { versions: { installed: String(pair[1]), offered: String(pair[2]) } } : {}),
    labels: options.map(({ label }) => label),
  };
}

export function createCodexUpdateDialogRequest(
  elwoodSessionId: string,
  offer: CodexUpdateOffer,
): ElwoodUpdateDialogRequest {
  return Object.freeze({
    id: randomUUID(),
    elwoodSessionId,
    agent: "codex",
    kind: "update",
    label: "codex_update",
    ...(offer.versions ? { versions: Object.freeze({ ...offer.versions }) } : {}),
    text: offer.text,
    choices: Object.freeze(offer.labels.map((label) => Object.freeze({ id: randomUUID(), label }))),
  });
}
