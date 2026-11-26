/**
 * How a listed Codex update offer ends: replaced, lost, closed, or taken back by a new skip
 * (PRD §5.13 "Codex update offers", C-ATTN-10).
 */

import { afterEach, expect, test } from "vitest";
import { resetFakes } from "./helpers.ts";
import { closing, listed, newerOffer, offer, openCodex, summary } from "./update-dialog-fixture.ts";

afterEach(resetFakes);

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

test("C-ATTN-10 a different offer replaces the listed one with new IDs", async () => {
  const { session, events, show, id } = await listed();
  await closing(session, async () => {
    await show(newerOffer);
    const [next] = await session.listDialogs();
    expect(next).toMatchObject({ versions: { installed: "0.172.0", offered: "99.1.0" } });
    expect(next!.id).not.toBe(id);
    await expect
      .poll(() => summary(events))
      .toEqual([
        ["raised", id],
        ["closed", "replaced"],
        ["raised", next!.id],
      ]);
  });
});

test("C-ATTN-10 unsettled output keeps the request, and a settled unknown screen ends it", async () => {
  const { session, events, show, id, pty } = await listed();
  await closing(session, async () => {
    pty.emitData("\u001b[?2026h");
    expect((await session.listDialogs()).map((request) => request.id)).toEqual([id]);
    pty.emitData("\u001b[?2026l");
    await show("Something else entirely");
    expect(await session.listDialogs()).toEqual([]);
    await expect
      .poll(() => summary(events))
      .toEqual([
        ["raised", id],
        ["closed", "unavailable"],
      ]);
  });
});

test("C-ATTN-10 host output ends update discovery for the life of the terminal", async () => {
  const { session, events, show, id } = await listed();
  await closing(session, async () => {
    session.terminal.writeOutput("host banner\r\n");
    await expect
      .poll(() => summary(events))
      .toEqual([
        ["raised", id],
        ["closed", "unavailable"],
      ]);
    await show(offer);
    expect(await session.listDialogs()).toEqual([]);
  });
});

test("C-ATTN-10 closing the session closes the listed request", async () => {
  const { session, events, id } = await listed();
  await session.stop();
  await expect
    .poll(() => summary(events))
    .toEqual([
      ["raised", id],
      ["closed", "unavailable"],
    ]);
});

test("C-ATTN-10 a new skip of the offer takes it back from the host", async () => {
  const { session, events, show } = await openCodex();
  await closing(session, async () => {
    await show(noSafeChoice);
    const [request] = await session.listDialogs();
    expect(request?.choices.map((choice) => choice.label)).toEqual([
      "Skip",
      "Update now (runs `npm install -g @openai/codex`)",
    ]);
    await show(offer);
    expect(await session.listDialogs()).toEqual([]);
    await expect
      .poll(() => summary(events))
      .toEqual([
        ["raised", request!.id],
        ["closed", "unavailable"],
      ]);
  });
});

test("C-ATTN-10 answerDialog does not answer an update request", async () => {
  const { session } = await listed();
  await closing(session, async () => {
    const [request] = await session.listDialogs();
    await expect(session.answerDialog(request!.id, request!.choices[1]!.id)).rejects.toMatchObject({
      code: "dialog_not_found",
    });
  });
});
