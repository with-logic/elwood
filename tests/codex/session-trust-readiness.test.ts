/** Native Codex trust gates hold queued input independently of attention (C-API-28). */

import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { startCodex } from "../../src/index.ts";
import { codexComposer, codexTty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

const codexDirectoryTrustFrame = readFileSync(
  new URL("../fixtures/codex-0.154.0/directory.txt", import.meta.url),
  "utf8",
);
const codexHooksTrustFrame = readFileSync(
  new URL("../fixtures/codex-0.154.0/hooks.txt", import.meta.url),
  "utf8",
);

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

test.each([
  [true, codexDirectoryTrustFrame, "1\r"],
  [false, codexHooksTrustFrame, "2\r"],
] as const)("C-TRUST-01 Codex native trust holds readiness after ignored numbered writes (%s)", async (autotrust, frame, answer) => {
  installFakes({ supportsHookTrustBypass: false });
  const session = await startCodex({ cwd: tempDir(), autotrust });
  try {
    const attention: string[] = [];
    const answered: string[] = [];
    const warnings: string[] = [];
    session.on("warning", (event) => warnings.push(event.code));
    session.on("activity", (event) => {
      if (event.kind === "attention") attention.push(event.label);
      if (event.kind === "startup_prompt") answered.push(event.label);
    });
    const queued = session.sendMessage("hello");
    void queued.catch(() => undefined);
    vi.useFakeTimers();
    ptys[0]!.emitData(frame.replaceAll("\n", "\r\n"));
    await vi.advanceTimersByTimeAsync(11_000);
    expect(ptys[0]!.writes.length).toBeGreaterThan(1);
    expect(ptys[0]!.writes.every((input) => input === answer)).toBe(true);
    expect(answered).toEqual([]);
    expect(warnings).toEqual([]);
    expect(session.status).not.toBe("ready");
    expect(session.status).toBe("blocked");
    expect(attention).toContain(`codex-${autotrust ? "workspace_trust" : "hook_trust"}-prompt`);
    ptys[0]!.emitData(`\u001b[2J\u001b[H${codexTty(codexComposer)}`);
    await vi.advanceTimersByTimeAsync(500);
    await queued;
    expect(ptys[0]!.writes).toContain("\u001b[200~hello\u001b[201~");
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});
