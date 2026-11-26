/**
 * Opens a Codex session on an update offer that raw caller input has taken over, so the
 * session lists it as a `kind: "update"` request (PRD §5.13 "Codex update offers",
 * C-ATTN-12). Offers are real standalone Codex 0.172.0 captures, edited where a test needs
 * another version or choice order.
 */

import { vi } from "vitest";
import { type CodexSessionApi, type ElwoodDialogEvent, startCodex } from "../../src/index.ts";
import { tty } from "../fixtures/trust-composer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { installFakes, ptys, render, tempDir } from "./helpers.ts";

export const offer = capturedFrame("codex-0.172.0/update/offer-standalone-100x30");
/** The same offer for a newer release: a different offer, not a redraw. */
export const newerOffer = offer.replace("→ 99.0.0", "→ 99.1.0");

/** Each event's phase, then its request ID when raised or its reason when closed. */
export const summary = (events: readonly ElwoodDialogEvent[]) =>
  events.map((event) => [event.phase, event.phase === "closed" ? event.reason : event.request.id]);

export async function openCodex() {
  installFakes();
  const session = await startCodex({ cwd: tempDir(), initialSize: { cols: 100, rows: 30 } });
  const events: ElwoodDialogEvent[] = [];
  session.on("dialog", (event) => {
    events.push(event);
  });
  /** Codex hides the cursor on the offer. */
  const show = (text: string) => render(session, `${tty(text)}\u001b[?25l`);
  return { session, events, show, pty: ptys.at(-1)! };
}

/** A session whose offer raw caller input took over, listed and announced. */
export async function listed() {
  const opened = await openCodex();
  await opened.show(offer);
  await opened.session.sendKeys("\u001b[B");
  const [request] = await opened.session.listDialogs();
  await vi.waitFor(() => {
    if (opened.events.length !== 1) throw new Error("the offer is not announced yet");
  });
  return { ...opened, id: request!.id };
}

export async function closing(session: CodexSessionApi, run: () => Promise<void>) {
  try {
    await run();
  } finally {
    await session.stop();
  }
}
