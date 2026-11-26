/**
 * A paste written at `ready` can still be staged when Claude's auto-mode offer paints over
 * it. Its Enter is held, and the captured frame after the offer closes, the composer still
 * holding that paste, releases it. Only input still awaiting its Enter gets that clearance.
 * Elwood declines the offer itself unless raw input reached it first
 * (C-ATTN-09, C-ATTN-02, C-API-56, C-CLAUDE-27, PRD §5.3, §5.1).
 */
import { afterEach, expect, test } from "vitest";
import { nativeFrameOutput, readNativeInputFrame } from "../fixtures/native-input-frame.ts";
import { offerOnScreen, permissionScreen } from "../fixtures/offer-frames.ts";
import { createFacadeFixture, nativeHooks, resetAdapters } from "../fixtures/owned-turn/session.ts";
import type { FakePty } from "../helpers/fake-pty.ts";

afterEach(resetAdapters);

const closed = nativeFrameOutput(
  readNativeInputFrame(
    new URL("../fixtures/claude-2.1.332/offer-closed-staged.json", import.meta.url),
  ),
);
const prompt = "Check: line one.\nLine two.\nLine three.\nReply with exactly OK.";
const paste = `\u001b[200~${prompt}\u001b[201~`;
const esc = "\u001b";
/** Past the paste's 150 ms settle delay, the first 1 s recovery Enter and Elwood's decline. */
const heldMs = 1_200;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A 140x40 Claude session, past its readiness hook, that paints `dialog` once `trigger` is
 * written. `painted()` is when the dialog painted, and `firstWriteAtMs` when each payload first
 * went out.
 */
async function withOfferOn(trigger: string, dialog = offerOnScreen) {
  const { helper, cwd, facade } = createFacadeFixture("claude", {
    initialSize: { cols: 140, rows: 40 },
  });
  const live = await facade.start();
  const pty: FakePty = helper.ptys[0]!;
  await nativeHooks("claude", live, cwd, pty).ready();
  const write = pty.write.bind(pty);
  const firstWriteAtMs = new Map<string, number>();
  let paintedAtMs: number | undefined;
  pty.write = (data) => {
    write(data);
    if (typeof data === "string" && !firstWriteAtMs.has(data))
      firstWriteAtMs.set(data, performance.now());
    if (data !== trigger) return;
    paintedAtMs = performance.now();
    pty.emitData(dialog);
  };
  return { facade, live, pty, firstWriteAtMs, painted: () => paintedAtMs };
}

test("C-ATTN-09 C-CLAUDE-27 an Enter held behind the offer submits the paste it closed over", async () => {
  const { facade, live, pty, firstWriteAtMs, painted } = await withOfferOn(paste);
  try {
    await expect.poll(() => live.status).toBe("ready");
    const declined: unknown[] = [];
    live.on("activity", (activity) => {
      if (activity.kind === "startup_prompt") declined.push(activity.label);
    });
    const sending = live.sendMessage(prompt);
    void sending.catch(() => undefined);
    await expect.poll(() => live.status).toBe("blocked");

    // Elwood declines the offer, past its input guard; the composer it closes over still
    // holds the paste, and the held Enter submits it.
    await expect.poll(() => pty.writes, { timeout: 3_000 }).toEqual([paste, esc]);
    const paintedAtMs = painted();
    const declinedAtMs = firstWriteAtMs.get(esc);
    expect(paintedAtMs).toBeDefined();
    expect(declinedAtMs).toBeDefined();
    // Measured on the monotonic clock. Node timers can fire a millisecond early, so allow a few.
    expect(
      Number(declinedAtMs) - Number(paintedAtMs),
      "Elwood's Esc went out past the offer's input guard",
    ).toBeGreaterThanOrEqual(750 - 25);
    expect(declined).toEqual([]);
    pty.emitData(closed);
    await expect.poll(() => pty.writes).toEqual([paste, esc, "\r"]);
    await sending;
    expect(live.status).toBe("running");
    // Reported once a settled frame shows the offer gone.
    await expect.poll(() => declined, { timeout: 3_000 }).toEqual(["auto_mode_setup"]);
  } finally {
    await facade.teardown();
  }
});

test("C-ATTN-09 an Enter held behind another Claude dialog submits the paste it closed over", async () => {
  const { facade, live, pty } = await withOfferOn(paste, permissionScreen);
  try {
    await expect.poll(() => live.status).toBe("ready");
    const sending = live.sendMessage(prompt);
    void sending.catch(() => undefined);
    await expect.poll(() => live.status).toBe("blocked");
    await wait(heldMs);
    expect(pty.writes).toEqual([paste]);

    // The human dismisses the dialog; the composer it closes over still holds the paste.
    await facade.sendKeys(esc);
    pty.emitData(closed);
    await expect.poll(() => pty.writes).toEqual([paste, esc, "\r"]);
    await sending;
    expect(live.status).toBe("running");
  } finally {
    await facade.teardown();
  }
});

test.each([
  { key: esc, after: "the offer closes", frame: closed },
  { key: "\u001b[B", after: "the offer stays open", frame: undefined },
])("C-ATTN-09 C-API-56 awaited input taken over during the hold rejects without its Enter when $after", async ({
  key,
  frame,
}) => {
  const { facade, live, pty } = await withOfferOn(paste);
  try {
    await expect.poll(() => live.status).toBe("ready");
    const sending = facade.send(prompt).catch((error: unknown) => error);
    await expect.poll(() => live.status).toBe("blocked");
    expect(pty.writes).toEqual([paste]);

    // A raw key before Elwood's decline also hands the offer to the human.
    await facade.sendKeys(key);
    if (frame !== undefined) pty.emitData(frame);
    expect(await sending).toMatchObject({
      code: "wait_timeout",
      message: "Raw input replaced the staged turn input.",
    });
    await wait(heldMs);
    await live.terminal.settled();
    expect(pty.writes).toEqual([paste, key]);
  } finally {
    await facade.teardown();
  }
});

test("C-ATTN-09 a draft left after awaited input's Enter does not clear the offer", async () => {
  const { facade, live, pty } = await withOfferOn("\r");
  let sending: Promise<unknown> | undefined;
  try {
    await expect.poll(() => live.status).toBe("ready");
    sending = facade.send(prompt).catch((error: unknown) => error);
    await expect.poll(() => live.status).toBe("blocked");
    expect(pty.writes).toEqual([paste, "\r"]);

    // The offer closes over the still-staged draft, with no raw input from anyone.
    pty.emitData(closed);
    await live.terminal.settled();
    expect(live.status).toBe("blocked");
    await wait(heldMs);
    expect(live.status).toBe("blocked");
    expect(pty.writes).toEqual([paste, "\r"]);
  } finally {
    await facade.teardown();
    await sending;
  }
});

test("C-CLAUDE-27 a raw key that reaches the offer before Elwood's first frame of it keeps it the human's", async () => {
  const down = "\u001b[B";
  // Claude shows the menu by the time the key lands; Elwood sees it only after the write.
  const { facade, live, pty } = await withOfferOn(down);
  try {
    await expect.poll(() => live.status).toBe("ready");
    await facade.sendKeys(down);
    await expect.poll(() => live.status).toBe("blocked");
    await wait(heldMs);
    await live.terminal.settled();
    expect(pty.writes).toEqual([down]);
  } finally {
    await facade.teardown();
  }
});
