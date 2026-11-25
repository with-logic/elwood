/**
 * A paste written at `ready` can still be staged when Claude's auto-mode offer paints over
 * it. Its Enter is held, and the captured frame after the offer closes, the composer still
 * holding that paste, releases it (C-ATTN-09, C-ATTN-02, PRD §5.3).
 */
import { afterEach, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { nativeFrameOutput, readNativeInputFrame } from "../fixtures/native-input-frame.ts";
import { tty } from "../fixtures/trust-composer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

const offer = capturedFrame("claude-2.1.332/auto-mode-offer");
const closed = readNativeInputFrame(
  new URL("../fixtures/claude-2.1.332/offer-closed-staged.json", import.meta.url),
);
const prompt = "Check: line one.\nLine two.\nLine three.\nReply with exactly OK.";
const paste = `\u001b[200~${prompt}\u001b[201~`;

test("C-ATTN-09 an Enter held behind the offer submits the paste it closed over", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startClaude({ cwd, initialSize: { cols: 140, rows: 40 } });
  try {
    const pty = ptys[0]!;
    await pty.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "InstructionsLoaded",
      session_id: "claude-1",
      cwd,
      file_path: "/tmp/CLAUDE.md",
      memory_type: "Project",
      load_reason: "session_start",
    });
    await expect.poll(() => session.status).toBe("ready");
    const sending = session.sendMessage(prompt);
    void sending.catch(() => undefined);
    await expect.poll(() => pty.writes).toEqual([paste]);
    // The offer paints inside the paste's settle window, before its Enter.
    pty.emitData(`\u001b[2J\u001b[H${tty(offer)}\u001b[32;3H`);
    await session.terminal.settled();
    expect(session.status).toBe("blocked");
    // Well past the 150 ms settle delay: the Enter is still held.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(pty.writes).toEqual([paste]);

    pty.emitData(nativeFrameOutput(closed));
    await session.terminal.settled();
    await expect.poll(() => pty.writes).toEqual([paste, "\r"]);
    await sending;
    expect(session.status).toBe("running");
  } finally {
    await session.stop();
  }
});
