/**
 * Automated startup writes observe received PTY output before writing, so a screen that
 * arrived while the previous frame was rendering is never written against a stale
 * snapshot (PRD §4.1/§5.1/§5.4, C-API-56).
 */
import { afterEach, expect, test, vi } from "vitest";
import { startCodex } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

const updateScreen = "Update available! 0.148.0 -> 0.149.1\n› 1. Update now\n  2. Skip";
/** An allowlisted Codex trust gate: recognized on `main`, so it holds without this PR. */
const trustGate =
  "Do you trust the contents of this directory?\n\n› 1. Yes, continue\n  2. No, quit\n\n  Press enter to continue";
const cleared = (frame: string) => `[2J[H${frame.replaceAll("\n", "\r\n")}`;

test("C-API-56 an update skip is withheld when a trust gate arrives mid-write", async () => {
  installFakes();
  // autotrust off: the gate is human-owned, so nothing may answer it.
  const session = await startCodex({ cwd: tempDir(), autotrust: false });
  const pty = ptys.at(-1)!;
  // The race: the update screen RENDERED (so automation decided to skip), and the gate's
  // bytes arrive in that same turn — received, not yet observed — while the skip key is
  // still in flight. Without the barrier the key lands in the gate.
  let painted = false;
  session.on("terminal:data", () => {
    if (painted || !session.terminal.snapshot().text.includes("Skip")) return;
    painted = true;
    pty.emitData(cleared(trustGate));
  });
  try {
    pty.emitData(cleared(updateScreen));
    await vi.waitFor(() => expect(session.terminal.snapshot().text).toContain("No, quit"));
    await vi.waitFor(() => expect(session.status).toBe("blocked"), { timeout: 5_000 });
    // Give the update-skip retry loop a full window to misfire into the gate.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(pty.writes).toEqual([]); // no "2" reached the gate
  } finally {
    await session.teardown();
  }
});
