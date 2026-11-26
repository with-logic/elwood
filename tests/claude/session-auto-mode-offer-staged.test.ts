/**
 * A paste written at `ready` can still be staged when Claude's auto-mode offer paints over
 * it. Its Enter is held, and the captured frame after the offer closes, the composer still
 * holding that paste, releases it. Only input still awaiting its Enter gets that clearance
 * (C-ATTN-09, C-ATTN-02, C-API-56, PRD §5.3).
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
/** Well past the paste's 150 ms settle delay, and past the first 1 s recovery Enter. */
const heldMs = 1_200;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A 140x40 Claude session, past its readiness hook, that paints `dialog` once `trigger` is written. */
async function withOfferOn(trigger: string, dialog = offerOnScreen) {
  const { helper, cwd, facade } = createFacadeFixture("claude", {
    initialSize: { cols: 140, rows: 40 },
  });
  const live = await facade.start();
  const pty: FakePty = helper.ptys[0]!;
  await nativeHooks("claude", live, cwd, pty).ready();
  const write = pty.write.bind(pty);
  pty.write = (data) => {
    write(data);
    if (data === trigger) pty.emitData(dialog);
  };
  return { facade, live, pty };
}

test.each([
  { dialog: "the offer", frame: offerOnScreen },
  { dialog: "another Claude dialog", frame: permissionScreen },
])("C-ATTN-09 an Enter held behind $dialog submits the paste it closed over", async ({ frame }) => {
  const { facade, live, pty } = await withOfferOn(paste, frame);
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
    await wait(heldMs);
    expect(pty.writes).toEqual([paste]);

    await facade.sendKeys(key);
    if (frame !== undefined) pty.emitData(frame);
    expect(await sending).toMatchObject({
      code: "wait_timeout",
      message: "Raw input replaced the staged turn input.",
    });
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
