/**
 * How late, nested and failing `dialog` listeners see a listed Codex update offer
 * (PRD §5.13 "Codex update offers", C-ATTN-10).
 */

import { afterEach, expect, test, vi } from "vitest";
import type { ElwoodDialogEvent, ElwoodWarningEvent } from "../../src/index.ts";
import { resetFakes } from "./helpers.ts";
import { closing, listed, newerOffer, offer, openCodex, summary } from "./update-dialog-fixture.ts";

afterEach(resetFakes);

test("C-ATTN-10 a late listener gets one replay; one that leaves first gets none", async () => {
  const { session, events, id } = await listed();
  await closing(session, async () => {
    const late: ElwoodDialogEvent[] = [];
    const gone = vi.fn();
    session.on("dialog", (event) => {
      late.push(event);
    });
    session.on("dialog", gone)();
    await expect.poll(() => summary(late)).toEqual([["raised", id]]);
    expect(Object.isFrozen(late[0])).toBe(true);
    expect(summary(events)).toEqual([["raised", id]]);
    expect(gone).not.toHaveBeenCalled();
  });
});

test("C-ATTN-10 a listener added while a raise waits for dispatch gets that dispatch once", async () => {
  const { session, show, id } = await listed();
  await closing(session, async () => {
    const nested: ElwoodDialogEvent[] = [];
    const off = session.on("dialog", (event) => {
      if (event.phase !== "closed") return;
      off();
      session.on("dialog", (later) => {
        nested.push(later);
      });
    });
    await show(newerOffer);
    const [next] = await session.listDialogs();
    expect(next!.id).not.toBe(id);
    await expect.poll(() => summary(nested)).toEqual([["raised", next!.id]]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(summary(nested)).toEqual([["raised", next!.id]]);
  });
});

test("C-ATTN-10 a listener added during the raised dispatch gets a replay", async () => {
  const { session, events, show } = await openCodex();
  await closing(session, async () => {
    const nested: ElwoodDialogEvent[] = [];
    const off = session.on("dialog", () => {
      off();
      session.on("dialog", (event) => {
        nested.push(event);
      });
    });
    await show(offer);
    await session.sendKeys("\u001b[B");
    const [request] = await session.listDialogs();
    await expect.poll(() => summary(nested)).toEqual([["raised", request!.id]]);
    expect(nested[0]?.request).toBe(events[0]?.request);
  });
});

test("C-ATTN-10 a throwing dialog listener produces one warning and does not stop delivery", async () => {
  const { session, events, show } = await openCodex();
  const warnings: ElwoodWarningEvent[] = [];
  session.on("warning", (warning) => {
    warnings.push(warning);
  });
  session.on("dialog", () => {
    throw new Error("listener failure");
  });
  await closing(session, async () => {
    await show(offer);
    await session.sendKeys("\u001b[B");
    await session.listDialogs();
    await show(newerOffer);
    await expect
      .poll(() => events.map((event) => event.phase))
      .toEqual(["raised", "closed", "raised"]);
    expect(warnings.map((warning) => warning.code)).toEqual(["dialog_observer_failed"]);
  });
});
