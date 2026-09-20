/** Native composer clearance releases real queued session input (PRD §5.4, C-TRUST-01). */
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { startCodex } from "../../src/index.ts";
import { codexComposer, codexSmallComposer, codexTrust, tty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

const capturedComposer = readFileSync(
  new URL("../fixtures/codex-0.142.5/composer-model-only.txt", import.meta.url),
  "utf8",
);

test.each([
  capturedComposer,
  `1. First step\n2. Second step\n${codexSmallComposer}`,
  "› Explain this codebase\n  gpt-5.5 high",
  codexComposer.slice(0, codexComposer.lastIndexOf("\n")),
])("C-TRUST-01 queues caller input until verified composer clearance: %s", async (clearance) => {
  installFakes();
  const session = await startCodex({ cwd: tempDir(), autotrust: true });
  try {
    vi.useFakeTimers();
    const queued = session.sendMessage("after trust");
    ptys[0]!.emitData(tty(`${codexTrust}\n› 1. Yes, continue\n  2. No, quit`));
    await vi.advanceTimersByTimeAsync(6000);
    const callerText = "\u001b[200~after trust\u001b[201~";
    expect(ptys[0]!.writes).not.toContain(callerText);
    const render = async (frame: string) => {
      ptys[0]!.emitData(`\u001b[2J\u001b[H${tty(frame)}`);
      await vi.advanceTimersByTimeAsync(500);
    };
    await render(`${codexSmallComposer}\n› `);
    expect(ptys[0]!.writes).not.toContain(callerText);
    await render(clearance);
    await queued;
    expect(ptys[0]!.writes.filter((input) => input === callerText)).toHaveLength(1);
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});
