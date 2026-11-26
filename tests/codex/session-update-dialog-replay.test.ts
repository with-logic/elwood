/**
 * How late, nested and failing `dialog` listeners see a listed Codex update offer
 * (PRD §5.13 "Codex update offers", C-ATTN-12).
 */

import { afterEach, expect, test, vi } from "vitest";
import type { ElwoodDialogEvent, ElwoodWarningEvent } from "../../src/index.ts";
import { resetFakes } from "./helpers.ts";
import {
  closing,
  firstListed,
  listed,
  newerOffer,
  offer,
  openCodex,
  summary,
} from "./update-dialog-fixture.ts";

afterEach(resetFakes);

test("C-ATTN-12 a late listener gets one replay; one that leaves first gets none", async () => {
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

test("C-ATTN-12 the first listener, added after a raise no listener saw, gets one replay", async () => {
  const { session, show } = await openCodex({ listen: false });
  await closing(session, async () => {
    await show(offer);
    await session.sendKeys("\u001b[B");
    const { id } = await firstListed(session);
    // The raise is dispatched to no listener before this one registers.
    await new Promise((resolve) => setImmediate(resolve));
    const late: ElwoodDialogEvent[] = [];
    session.on("dialog", (event) => {
      late.push(event);
    });
    await expect.poll(() => summary(late)).toEqual([["raised", id]]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(summary(late)).toEqual([["raised", id]]);
  });
});

test("C-ATTN-12 a listener an earlier replayed listener removes gets no replay", async () => {
  const { session, id } = await listed();
  await closing(session, async () => {
    const first: ElwoodDialogEvent[] = [];
    const second = vi.fn();
    let removeSecond: () => void = () => undefined;
    session.on("dialog", (event) => {
      first.push(event);
      removeSecond();
    });
    removeSecond = session.on("dialog", second);
    await expect.poll(() => summary(first)).toEqual([["raised", id]]);
    expect(second).not.toHaveBeenCalled();
  });
});

test("C-ATTN-12 a listener added by a replayed listener waits for a fresh read of the offer", async () => {
  const { session, events, id } = await listed();
  await closing(session, async () => {
    const added: ElwoodDialogEvent[] = [];
    session.on("dialog", (event) => {
      if (event.phase !== "raised") return;
      // Host output ends native evidence for the life of the terminal (§5.13).
      session.terminal.writeOutput("host banner\r\n");
      session.on("dialog", (nested) => {
        added.push(nested);
      });
    });
    await expect
      .poll(() => summary(events))
      .toEqual([
        ["raised", id],
        ["closed", id, "unavailable"],
      ]);
    expect(summary(added)).toEqual([["closed", id, "unavailable"]]);
  });
});

test("C-ATTN-12 a listener added while a raise waits for dispatch gets that dispatch once", async () => {
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
    const next = await firstListed(session);
    expect(next.id).not.toBe(id);
    await expect.poll(() => summary(nested)).toEqual([["raised", next.id]]);
    // Deliveries and replays run in microtasks, which one macrotask turn drains.
    await new Promise((resolve) => setImmediate(resolve));
    expect(summary(nested)).toEqual([["raised", next.id]]);
  });
});

test("C-ATTN-12 a listener added during the raised dispatch gets a replay", async () => {
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
    const request = await firstListed(session);
    await expect.poll(() => summary(nested)).toEqual([["raised", request.id]]);
    expect(nested[0]?.request).toBe(events[0]?.request);
  });
});

test("C-ATTN-12 a throwing dialog listener produces one warning and does not stop delivery", async () => {
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
