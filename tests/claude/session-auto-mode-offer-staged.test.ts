/**
 * A paste written at `ready` can still be staged when Claude's auto-mode offer paints over
 * it. Its Enter is held, and the captured frame after the offer closes, the composer still
 * holding that paste, releases it. Only input still awaiting its Enter gets that clearance
 * (C-ATTN-09, C-ATTN-02, C-API-56, PRD §5.3).
 */
import { afterEach, expect, test } from "vitest";
import { nativeFrameOutput, readNativeInputFrame } from "../fixtures/native-input-frame.ts";
import { createFacadeFixture, nativeHooks, resetAdapters } from "../fixtures/owned-turn/session.ts";
import { tty } from "../fixtures/trust-composer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import type { FakePty } from "../helpers/fake-pty.ts";

afterEach(resetAdapters);

/** The captured offer; the hardware cursor sits on its `❯ 1. Yes` row, as Claude leaves it. */
const offer = `\u001b[2J\u001b[H${tty(capturedFrame("claude-2.1.332/auto-mode-offer").trimEnd())}\u001b[32;3H`;
const closed = nativeFrameOutput(
  readNativeInputFrame(
    new URL("../fixtures/claude-2.1.332/offer-closed-staged.json", import.meta.url),
  ),
);
const prompt = "Check: line one.\nLine two.\nLine three.\nReply with exactly OK.";
const paste = `\u001b[200~${prompt}\u001b[201~`;
const esc = "\u001b";
/** Well past the paste's 150 ms settle delay, and past the first 1 s recovery Enter. */
const heldMs = 1_200;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A 140x40 Claude session, past its readiness hook, that paints the offer once `trigger` is written. */
async function withOfferOn(trigger: string) {
  const { helper, cwd, facade } = createFacadeFixture("claude", {
    initialSize: { cols: 140, rows: 40 },
  });
  const live = await facade.start();
  const pty: FakePty = helper.ptys[0]!;
  await nativeHooks("claude", live, cwd, pty).ready();
  const write = pty.write.bind(pty);
  pty.write = (data) => {
    write(data);
    if (data === trigger) pty.emitData(offer);
  };
  return { facade, live, pty };
}

test("C-ATTN-09 an Enter held behind the offer submits the paste it closed over", async () => {
  const { facade, live, pty } = await withOfferOn(paste);
  try {
    await expect.poll(() => live.status).toBe("ready");
    const sending = live.sendMessage(prompt);
    void sending.catch(() => undefined);
    await expect.poll(() => live.status).toBe("blocked");
    await wait(heldMs);
    expect(pty.writes).toEqual([paste]);

    // The human dismisses the offer; the composer it closes over still holds the paste.
    await facade.sendKeys(esc);
    pty.emitData(closed);
    await expect.poll(() => pty.writes).toEqual([paste, esc, "\r"]);
    await sending;
    expect(live.status).toBe("running");
  } finally {
    await facade.teardown();
  }
});

test("C-ATTN-09 C-API-56 awaited input taken over during the hold rejects without its Enter", async () => {
  const { facade, live, pty } = await withOfferOn(paste);
  try {
    await expect.poll(() => live.status).toBe("ready");
    const sending = facade.send(prompt).catch((error: unknown) => error);
    await expect.poll(() => live.status).toBe("blocked");
    await wait(heldMs);
    expect(pty.writes).toEqual([paste]);

    await facade.sendKeys(esc);
    pty.emitData(closed);
    expect(await sending).toMatchObject({
      code: "wait_timeout",
      message: "Raw input replaced the staged turn input.",
    });
    await live.terminal.settled();
    expect(pty.writes).toEqual([paste, esc]);
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
