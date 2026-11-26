/**
 * How a listed Codex update offer ends: replaced, lost, closed, or taken back by a new skip
 * (PRD §5.13 "Codex update offers", C-ATTN-12).
 */

import { afterEach, expect, test, vi } from "vitest";
import { firstKeyDelayMs } from "../../src/codex/update-prompt.ts";
import type { CodexSessionApi } from "../../src/index.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { resetFakes } from "./helpers.ts";
import {
  closing,
  firstListed,
  listed,
  newerOffer,
  offer,
  openOnFakeTimers,
  required,
  summary,
} from "./update-dialog-fixture.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

/** Skip before the action is never selected, so Elwood leaves this offer to the host. */
const noSafeChoice = [
  "  Update available · 0.172.0 → 99.0.0",
  "  Release notes: https://github.com/openai/codex/releases/latest",
  "",
  "› 1. Skip",
  "  2. Update now (runs `npm install -g @openai/codex`)",
  "",
  "  enter continue · esc skip",
].join("\n");

test("C-ATTN-12 a different offer replaces the listed one with new IDs", async () => {
  const { session, events, show, id } = await listed();
  await closing(session, async () => {
    await show(newerOffer);
    const next = await firstListed(session);
    expect(next).toMatchObject({ versions: { installed: "0.172.0", offered: "99.1.0" } });
    expect(next.id).not.toBe(id);
    await expect
      .poll(() => summary(events))
      .toEqual([
        ["raised", id],
        ["closed", id, "replaced"],
        ["raised", next.id],
      ]);
  });
});

test("C-ATTN-12 unsettled output keeps the request, and a settled banner without choices ends it", async () => {
  const { session, events, show, id, pty } = await listed();
  await closing(session, async () => {
    pty.emitData("\u001b[?2026h");
    expect((await session.listDialogs()).map((request) => request.id)).toEqual([id]);
    pty.emitData("\u001b[?2026l");
    await show(offer.split("\n").slice(0, 3).join("\n"));
    expect(await session.listDialogs()).toEqual([]);
    await expect
      .poll(() => summary(events))
      .toEqual([
        ["raised", id],
        ["closed", id, "unavailable"],
      ]);
  });
});

test("C-ATTN-12 a settled screen without the banner clears the request, even before a composer", async () => {
  const { session, events, show, id } = await listed();
  await closing(session, async () => {
    // Codex 0.172.0's first screen after a skip on a start: its header alone.
    await show(capturedFrame("codex-0.172.0/update/start-boot-partial"));
    expect(await session.listDialogs()).toEqual([]);
    await expect
      .poll(() => summary(events))
      .toEqual([
        ["raised", id],
        ["closed", id, "cleared"],
      ]);
  });
});

test.each([
  ["host output", (session: CodexSessionApi) => session.terminal.writeOutput("host banner\r\n")],
  ["a size change", (session: CodexSessionApi) => session.resize({ cols: 90, rows: 30 })],
])("C-ATTN-12 %s ends update discovery for the life of the terminal", async (_, revoke) => {
  const { session, events, show, id } = await listed();
  await closing(session, async () => {
    await revoke(session);
    await expect
      .poll(() => summary(events))
      .toEqual([
        ["raised", id],
        ["closed", id, "unavailable"],
      ]);
    await show(offer);
    expect(await session.listDialogs()).toEqual([]);
  });
});

test("C-ATTN-12 closing the session closes the listed request", async () => {
  const { session, events, id } = await listed();
  await session.stop();
  await expect
    .poll(() => summary(events))
    .toEqual([
      ["raised", id],
      ["closed", id, "unavailable"],
    ]);
});

test("C-ATTN-12 an offer with no safe choice is listed with nothing written, until a new skip takes it back", async () => {
  const { session, pty, events, paintOffer } = await openOnFakeTimers();
  await closing(session, async () => {
    await paintOffer(noSafeChoice);
    const request = await firstListed(session);
    expect(request.choices.map((choice) => choice.label)).toEqual([
      "Skip",
      "Update now (runs `npm install -g @openai/codex`)",
    ]);
    // Past the first-key wait and every retry, Elwood types nothing on this offer.
    await vi.advanceTimersByTimeAsync(firstKeyDelayMs + 5_000);
    expect(pty.writes).toEqual([]);
    expect(await session.listDialogs()).toEqual([request]);
    await paintOffer(offer);
    expect(await session.listDialogs()).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(summary(events)).toEqual([
      ["raised", request.id],
      ["closed", request.id, "unavailable"],
    ]);
  });
});

test("C-ATTN-12 answerDialog does not answer an update request", async () => {
  const { session } = await listed();
  await closing(session, async () => {
    const request = await firstListed(session);
    await expect(
      session.answerDialog(request.id, required(request.choices[1], "the Skip choice").id),
    ).rejects.toMatchObject({
      code: "dialog_not_found",
    });
  });
});
