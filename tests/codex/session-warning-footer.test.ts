/** Captured Codex 0.159.2 warning footer clears trust only at live idle (C-TRUST-01/C-API-28). */
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { codexComposerClearance } from "../../src/codex/screen/clearance.ts";
import { startCodex } from "../../src/index.ts";
import { asScreen } from "../helpers/model-pickers.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

const captured = readFileSync(
  new URL("../fixtures/codex-0.159.2/warning-composer.txt", import.meta.url),
  "utf8",
);
const trust = readFileSync(
  new URL("../fixtures/codex-0.154.0/directory.txt", import.meta.url),
  "utf8",
);
const cursorRow = captured.split("\n").findIndex((row) => row.startsWith("› ")) + 1;
const paint = (text: string, visible = true) =>
  `${asScreen(text)}\u001b[${cursorRow};3H\u001b[?25${visible ? "h" : "l"}`;

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

test("C-TRUST-01 captured warning footer requires native chrome and an exact suffix", () => {
  expect(codexComposerClearance(captured)).toBe(true);
  expect(codexComposerClearance(captured.replace("3 warnings", "1 warning"))).toBe(true);
  expect(codexComposerClearance(captured.replace("3 warnings", "10 warnings"))).toBe(true);
  for (const suffix of ["0 warnings", "three warnings", "3 warnings · press Enter", "3 alerts"])
    expect(codexComposerClearance(captured.replace("3 warnings", suffix))).toBe(false);
  expect(codexComposerClearance(`${captured}\n1. Yes\n2. No`)).toBe(false);
  expect(codexComposerClearance(captured.replace(/ {2}gpt-[^\n]+\n/, ""))).toBe(false);
  expect(codexComposerClearance(`Would you like to run the following command?\n${captured}`)).toBe(
    false,
  );
});

test("C-API-28 a live warning footer releases deferred trust readiness, not hidden or dialog frames", async () => {
  installFakes();
  const session = await startCodex({
    cwd: tempDir(),
    autotrust: true,
    initialSize: { cols: 140, rows: 35 },
  });
  const queued = session.sendMessage("after trust");
  // Teardown rejects pending input if an assertion fails.
  void queued.catch(() => undefined);
  try {
    vi.useFakeTimers();
    const pty = ptys[0]!;
    pty.emitData(asScreen(trust));
    await vi.advanceTimersByTimeAsync(10_500);
    expect(session.status).toBe("blocked");
    expect(pty.writes).not.toContain("\u001b[200~after trust\u001b[201~");
    pty.emitData(paint(captured, false));
    await vi.advanceTimersByTimeAsync(100);
    expect(session.status).toBe("blocked");
    pty.emitData(paint(captured.replace("3 warnings", "3 warnings · press Enter")));
    await vi.advanceTimersByTimeAsync(100);
    expect(session.status).toBe("blocked");
    pty.emitData(
      paint(
        captured.replace(
          "  Follow the white cursor.",
          "Would you like to run the following command?",
        ),
      ),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(session.status).toBe("blocked");
    pty.emitData(`\u001b[?2026h${paint(captured)}`);
    await vi.advanceTimersByTimeAsync(100);
    expect(session.status).toBe("blocked");
    expect(pty.writes).not.toContain("\u001b[200~after trust\u001b[201~");
    pty.emitData("\u001b[?2026l");
    await vi.advanceTimersByTimeAsync(500);
    expect(pty.writes).toContain("\u001b[200~after trust\u001b[201~");
    await queued;
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});
