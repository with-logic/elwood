/**
 * Opens a Codex session on an update offer that raw caller input has taken over, so the
 * session lists it as a `kind: "update"` request (PRD §5.13 "Codex update offers",
 * C-ATTN-12). Offers are real standalone Codex 0.172.0 captures, edited where a test needs
 * another version or choice order.
 */

import { vi } from "vitest";
import {
  type CodexSessionApi,
  type ElwoodDialogEvent,
  type ElwoodDialogRequest,
  resumeCodex,
  startCodex,
} from "../../src/index.ts";
import { codexTty, tty } from "../fixtures/trust-composer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { becomeReady, installFakes, ptys, render, tempDir } from "./helpers.ts";

export const offer = capturedFrame("codex-0.172.0/update/offer-standalone-100x30");
/** The same offer for a newer release: a different offer, not a redraw. */
export const newerOffer = offer.replace("→ 99.0.0", "→ 99.1.0");

/** Each event's phase and request ID, then its reason when closed. */
export const summary = (events: readonly ElwoodDialogEvent[]) =>
  events.map((event) =>
    event.phase === "closed"
      ? [event.phase, event.request.id, event.reason]
      : [event.phase, event.request.id],
  );

/** `value`, or a failure that names what is missing rather than a TypeError on its use. */
export function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Missing ${what}`);
  return value;
}

/** The session's only listed request. */
export async function firstListed(session: CodexSessionApi): Promise<ElwoodDialogRequest> {
  return required((await session.listDialogs())[0], "a listed dialog request");
}

/** `listen: false` leaves the session without a `dialog` listener; `resume` resumes one. */
export async function openCodex({ listen = true, resume = false } = {}) {
  installFakes();
  const cwd = tempDir();
  const initialSize = { cols: 100, rows: 30 };
  let session = await startCodex({ cwd, initialSize });
  if (resume) {
    await becomeReady(session.elwoodSessionId, cwd);
    await session.stop();
    session = await resumeCodex({ cwd, initialSize, elwoodSessionId: session.elwoodSessionId });
  }
  const events: ElwoodDialogEvent[] = [];
  if (listen)
    session.on("dialog", (event) => {
      events.push(event);
    });
  /** Codex hides the cursor on the offer. */
  const show = (text: string) => render(session, `${tty(text)}\u001b[?25l`);
  return { session, events, show, cwd, pty: required(ptys.at(-1), "the session's PTY") };
}

/** The configured composer Codex 0.172.0 draws once a skip of its offer lands. */
export const skippedComposer = codexTty(
  capturedFrame("codex-0.172.0/update/start-skipped-composer").trimEnd(),
);

/** A session on fake timers, so the skip's delays pass without waiting for them. */
export async function openOnFakeTimers() {
  const opened = await openCodex();
  vi.useFakeTimers();
  const paint = async (frame: string) => {
    opened.pty.emitData(`\u001b[2J\u001b[H${frame}`);
    await vi.advanceTimersByTimeAsync(50);
  };
  /** Codex hides the cursor on the offer. */
  const paintOffer = (text = offer) => paint(`${tty(text)}\u001b[?25l`);
  return { ...opened, paint, paintOffer };
}

/** A session whose offer raw caller input took over, listed and announced. */
export async function listed() {
  const opened = await openCodex();
  await opened.show(offer);
  await opened.session.sendKeys("\u001b[B");
  const request = await firstListed(opened.session);
  await vi.waitFor(() => {
    if (opened.events.length !== 1) throw new Error("the offer is not announced yet");
  });
  return { ...opened, id: request.id };
}

export async function closing(session: CodexSessionApi, run: () => Promise<void>) {
  try {
    await run();
  } finally {
    await session.stop();
  }
}
