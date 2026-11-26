/**
 * A Codex session lists and announces its update offer once no Elwood skip answers it:
 * after raw caller input, or after the skip's bounded retries run out. The frames are real
 * standalone Codex 0.172.0 captures (PRD §5.13 "Codex update offers", C-ATTN-12).
 */

import { afterEach, expect, test } from "vitest";
import { firstKeyDelayMs } from "../../src/codex/update-prompt.ts";
import { type ElwoodDialogEvent, type ElwoodDialogRequest, startCodex } from "../../src/index.ts";
import { codexTty, tty } from "../fixtures/trust-composer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { becomeReady, installFakes, ptys, render, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

const offer = capturedFrame("codex-0.172.0/update/offer-standalone-100x30");
const composer = capturedFrame("codex-0.172.0/update/start-skipped-composer").trimEnd();
const down = "\u001b[B";
/** The skip's retries run 5 s after its first key, which waits 500 ms. */
const exhausted = { timeout: firstKeyDelayMs + 5_000 + 4_500 };

const expectedOffer = {
  agent: "codex",
  kind: "update",
  label: "codex_update",
  versions: { installed: "0.172.0", offered: "99.0.0" },
  text: "Update available · 0.172.0 → 99.0.0 Release notes: https://github.com/openai/codex/releases/latest",
  choices: [
    {
      id: expect.any(String),
      label: expect.stringMatching(/^Update now \(runs `sh -c 's=\$\(curl -fsSL https:/),
    },
    { id: expect.any(String), label: "Skip" },
    { id: expect.any(String), label: "Skip until next version" },
  ],
};

async function open() {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({ cwd, initialSize: { cols: 100, rows: 30 } });
  const events: ElwoodDialogEvent[] = [];
  session.on("dialog", (event) => {
    events.push(event);
  });
  const showOffer = (text = offer) => render(session, `${tty(text)}\u001b[?25l`);
  return { session, pty: ptys.at(-1)!, events, showOffer, cwd };
}

/** The phase and reason of each event, and whether it carries `request`. */
const phases = (events: readonly ElwoodDialogEvent[], request: ElwoodDialogRequest) =>
  events.map((event) => [
    event.phase,
    event.phase === "closed" ? event.reason : undefined,
    event.request === request,
  ]);

test("C-ATTN-12 raw caller input on the offer hands it to the host, and Codex's composer clears it", async () => {
  const { session, pty, events, showOffer } = await open();
  try {
    await showOffer();
    expect(await session.listDialogs()).toEqual([]);
    await session.sendKeys(down);
    const [request] = await session.listDialogs();
    expect(request).toEqual({
      ...expectedOffer,
      id: expect.any(String),
      elwoodSessionId: session.elwoodSessionId,
    });
    expect(Object.isFrozen(request) && Object.isFrozen(request?.choices)).toBe(true);
    await expect.poll(() => events.length).toBe(1);
    expect(phases(events, request!)).toEqual([["raised", undefined, true]]);
    // The caret moves to Skip: the same appearance keeps its request.
    await showOffer(offer.replace("› 1.", "  1.").replace("  2. Skip\n", "› 2. Skip\n"));
    expect(await session.listDialogs()).toEqual([request]);
    await new Promise((resolve) => setTimeout(resolve, firstKeyDelayMs + 500));
    expect(pty.writes).toEqual([down]);
    await render(session, codexTty(composer));
    expect(await session.listDialogs()).toEqual([]);
    await expect
      .poll(() => phases(events, request!))
      .toEqual([
        ["raised", undefined, true],
        ["closed", "cleared", true],
      ]);
  } finally {
    await session.stop();
  }
});

test("C-ATTN-12 an offer Elwood's skip answers is never listed or announced", async () => {
  const { session, pty, events, showOffer } = await open();
  try {
    await showOffer();
    await expect.poll(() => pty.writes, { timeout: firstKeyDelayMs + 4_500 }).toEqual(["2"]);
    expect(await session.listDialogs()).toEqual([]);
    await render(session, codexTty(composer));
    expect(await session.listDialogs()).toEqual([]);
    expect(events).toEqual([]);
  } finally {
    await session.stop();
  }
});

test("C-ATTN-12 an offer still drawn after the skip's retries run out is handed to the host", async () => {
  const { session, pty, events, showOffer } = await open();
  try {
    await showOffer();
    await expect.poll(() => events.length, exhausted).toBe(1);
    expect(pty.writes).toEqual(["2"]);
    const [request] = await session.listDialogs();
    expect(request).toMatchObject({ kind: "update", versions: expectedOffer.versions });
    expect(phases(events, request!)).toEqual([["raised", undefined, true]]);
  } finally {
    await session.stop();
  }
});

test("C-ATTN-12 the first readiness ends update discovery", async () => {
  const { session, events, showOffer, cwd } = await open();
  try {
    await render(session, codexTty(composer));
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    await showOffer();
    await session.sendKeys(down);
    expect(await session.listDialogs()).toEqual([]);
    expect(events).toEqual([]);
  } finally {
    await session.stop();
  }
});
