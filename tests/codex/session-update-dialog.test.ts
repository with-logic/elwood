/**
 * A Codex session lists and announces its update offer once no Elwood skip answers it:
 * after raw caller input, or after the skip's bounded retries run out. The frames are real
 * standalone Codex 0.172.0 captures (PRD §5.13 "Codex update offers", C-ATTN-12).
 */

import { afterEach, expect, test, vi } from "vitest";
import { firstKeyDelayMs } from "../../src/codex/update-prompt.ts";
import type { ElwoodDialogEvent, ElwoodDialogRequest } from "../../src/index.ts";
import { becomeReady, render, resetFakes } from "./helpers.ts";
import {
  closing,
  firstListed,
  newerOffer,
  offer,
  openCodex,
  openOnFakeTimers,
  skippedComposer,
} from "./update-dialog-fixture.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

const down = "\u001b[B";
/** The skip's first key waits 500 ms, and its retries run out 5 s after it. */
const skipRetriesMs = firstKeyDelayMs + 5_000;

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

/** The phase and reason of each event, and whether it carries `request`. */
const phases = (events: readonly ElwoodDialogEvent[], request: ElwoodDialogRequest) =>
  events.map((event) => [
    event.phase,
    event.phase === "closed" ? event.reason : undefined,
    event.request === request,
  ]);

test("C-ATTN-12 raw caller input on the offer hands it to the host, and Codex's composer clears it", async () => {
  const { session, pty, events, paint, paintOffer } = await openOnFakeTimers();
  await closing(session, async () => {
    await paintOffer();
    expect(await session.listDialogs()).toEqual([]);
    await session.sendKeys(down);
    const request = await firstListed(session);
    expect(request).toEqual({
      ...expectedOffer,
      id: expect.any(String),
      elwoodSessionId: session.elwoodSessionId,
    });
    expect(Object.isFrozen(request) && Object.isFrozen(request.choices)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(phases(events, request)).toEqual([["raised", undefined, true]]);
    // The caret moves to Skip: the same appearance keeps its request.
    await paintOffer(offer.replace("› 1.", "  1.").replace("  2. Skip\n", "› 2. Skip\n"));
    expect(await session.listDialogs()).toEqual([request]);
    // Past the skip's first key and its retries, Elwood still writes nothing of its own.
    await vi.advanceTimersByTimeAsync(skipRetriesMs);
    expect(pty.writes).toEqual([down]);
    await paint(skippedComposer);
    expect(await session.listDialogs()).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(phases(events, request)).toEqual([
      ["raised", undefined, true],
      ["closed", "cleared", true],
    ]);
  });
});

test("C-ATTN-12 an offer Elwood's skip answers is never listed or announced", async () => {
  const { session, pty, events, paint, paintOffer } = await openOnFakeTimers();
  await closing(session, async () => {
    await paintOffer();
    await vi.advanceTimersByTimeAsync(firstKeyDelayMs);
    expect(pty.writes).toEqual(["2"]);
    expect(await session.listDialogs()).toEqual([]);
    await paint(skippedComposer);
    expect(await session.listDialogs()).toEqual([]);
    expect(events).toEqual([]);
  });
});

test("C-ATTN-12 an offer still drawn after the skip's retries run out is handed to the host", async () => {
  const { session, pty, events, paintOffer } = await openOnFakeTimers();
  await closing(session, async () => {
    await paintOffer();
    await vi.advanceTimersByTimeAsync(firstKeyDelayMs);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(skipRetriesMs);
    expect(pty.writes).toEqual(["2"]);
    const request = await firstListed(session);
    expect(request).toMatchObject({ kind: "update", versions: expectedOffer.versions });
    expect(phases(events, request)).toEqual([["raised", undefined, true]]);
  });
});

test("C-ATTN-12 an earlier skip that settles while a newer one is pending keeps the offer unlisted", async () => {
  const { session, pty, events, paint, paintOffer } = await openOnFakeTimers();
  await closing(session, async () => {
    await paintOffer();
    // A different offer is a new appearance: Elwood starts a second skip while the first
    // waits for its key, and the first then settles without writing.
    await paintOffer(newerOffer);
    // Each skip's key waits 500 ms from its own frame, and the frames are 50 ms apart. Here
    // the first skip has settled without writing, and the second has not written yet.
    await vi.advanceTimersByTimeAsync(firstKeyDelayMs - 75);
    expect(pty.writes).toEqual([]);
    expect(await session.listDialogs()).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(pty.writes).toEqual(["2"]);
    expect(await session.listDialogs()).toEqual([]);
    await paint(skippedComposer);
    expect(await session.listDialogs()).toEqual([]);
    expect(events).toEqual([]);
  });
});

test("C-ATTN-12 the first readiness ends update discovery", async () => {
  const { session, events, show, cwd } = await openCodex();
  await closing(session, async () => {
    await render(session, skippedComposer);
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => session.status).toBe("ready");
    await show(offer);
    await session.sendKeys(down);
    expect(await session.listDialogs()).toEqual([]);
    expect(events).toEqual([]);
  });
});
