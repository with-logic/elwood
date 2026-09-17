/**
 * The Claude browser-tools decline observes received PTY output before writing, so a
 * trust gate that arrived while the previous frame was rendering takes no Escape
 * (PRD §4.1/§5.1/§5.4, C-API-56).
 */
import { afterEach, expect, test, vi } from "vitest";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

const browserPrompt =
  "Claude Code running in a browser?\n❯ 1. Yes, use my browser\n  2. No, keep browser tools off";
/** An allowlisted Claude trust gate: recognized on `main`, so it holds without this PR. */
const trustGate =
  "Do you trust this folder?\n\n❯ 1. Yes, proceed\n  2. No, exit\n\nEnter to confirm · Esc to cancel";
const cleared = (frame: string) => `[2J[H${frame.replaceAll("\n", "\r\n")}`;

test("C-API-56 a browser-tools decline is withheld when a trust gate arrives mid-write", async () => {
  installFakes();
  const session = await startClaude({ cwd: tempDir(), autotrust: false });
  const pty = ptys.at(-1)!;
  let painted = false;
  session.on("terminal:data", () => {
    if (painted || !session.terminal.snapshot().text.includes("keep browser tools off")) return;
    painted = true;
    pty.emitData(cleared(trustGate));
  });
  try {
    pty.emitData(cleared(browserPrompt));
    await vi.waitFor(() => expect(session.terminal.snapshot().text).toContain("No, exit"));
    await vi.waitFor(() => expect(session.status).toBe("blocked"), { timeout: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(pty.writes).toEqual([]); // no Escape reached the gate
  } finally {
    await session.teardown();
  }
});
