/**
 * Conformance tests for Claude image attachment through a real session (PRD
 * §5.3, C-API-44/45): a message with images pastes each absolute path before the
 * text, in one queued turn. Uses the fake PTY + real headless terminal so the
 * `[Image #N]` chip drives the attach wait.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

let cancelChips: (() => void) | undefined;
afterEach(() => {
  cancelChips?.(); // a failed test must not leave the chip driver rescheduling itself
  cancelChips = undefined;
  resetFakes();
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ESC = String.fromCharCode(27);
const paste = (text: string) => `${ESC}[200~${text}${ESC}[201~`;

/**
 * Emits the `[Image #k]` chips one at a time as each path paste lands, so every
 * per-image attach wait observes its own count increase (mirroring how the real
 * CLI adds one chip per pasted path). The chips are rendered on the LAST terminal
 * row (`ESC[999;1H`) so they land in the composer region the confirmation scans.
 */
function driveChips(count: number): void {
  let emitted = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    const pastes = ptys[0]!.writes.filter((w) => w.includes("[200~")).length;
    while (emitted < pastes && emitted < count) {
      emitted += 1;
      const chips = Array.from({ length: emitted }, (_, i) => `[Image #${i + 1}]`).join(" ");
      ptys[0]!.emitData(`[999;1H[K❯ ${chips}`);
    }
    if (emitted < count) timer = setTimeout(tick, 20);
  };
  timer = setTimeout(tick, 20);
  cancelChips = () => clearTimeout(timer);
}

async function ready(cwd: string, elwoodSessionId: string): Promise<void> {
  await ptys[0]!.dispatchHook(elwoodSessionId, {
    hook_event_name: "InstructionsLoaded",
    session_id: "claude-1",
    cwd,
    file_path: "/tmp/CLAUDE.md",
    memory_type: "Project",
    load_reason: "session_start",
  });
}

describe("ClaudeSessionApi image attachment (C-API-44/45)", () => {
  test("C-API-45 pastes each image path before the text in one turn", async () => {
    const cwd = tempDir();
    installFakes();
    const img = join(cwd, "shot.png");
    writeFileSync(img, PNG);
    const session = await startClaude({ cwd });
    const queued = session.sendMessage("look at this", {
      images: [{ path: img }, { data: PNG, format: "png" }],
    });
    await ready(cwd, session.elwoodSessionId);
    // Each per-image wait needs its OWN chip-count increase, so the chips must
    // appear one at a time — emit chip N once the Nth path paste has landed.
    driveChips(2);
    await queued;
    const writes = ptys[0]!.writes;
    expect(writes[0]).toBe(paste(img));
    expect(writes[1]?.startsWith(`${ESC}[200~`)).toBe(true);
    expect(writes[1]?.endsWith(`.png${ESC}[201~`)).toBe(true);
    expect(writes).toContain(paste("look at this"));
    expect(writes).toContain("\r");
    // The text paste comes AFTER both image pastes.
    expect(writes.indexOf(paste("look at this"))).toBeGreaterThan(1);
  }, 20_000);

  test("C-API-44 an invalid image rejects the whole submission and pastes nothing", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const promise = session.sendMessage("hi", { images: [{ path: join(cwd, "missing.png") }] });
    // Attach the rejection handler BEFORE driving readiness (validation rejects at
    // dispatch), so the rejection is never momentarily unhandled.
    const settled = expect(promise).rejects.toMatchObject({ code: "invalid_image" });
    await ready(cwd, session.elwoodSessionId);
    await settled;
    expect(ptys[0]!.writes).toEqual([]);
  });

  test("C-API-44 a message with an empty image list keeps the plain text path", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const queued = session.sendMessage("plain", { images: [] });
    await ready(cwd, session.elwoodSessionId);
    await queued;
    expect(ptys[0]!.writes[0]).toBe(paste("plain"));
  });

  for (const method of ["sendMessage", "sendPrompt", "sendGuidance"] as const) {
    test(`C-API-44 ${method} attaches the image before its text`, async () => {
      const cwd = tempDir();
      installFakes();
      const img = join(cwd, "shot.png");
      writeFileSync(img, PNG);
      const session = await startClaude({ cwd });
      const queued = session[method]("caption", { images: [{ path: img }] });
      await ready(cwd, session.elwoodSessionId);
      driveChips(1);
      await queued;
      const writes = ptys[0]!.writes;
      expect(writes[0]).toBe(paste(img));
      expect(writes.indexOf(paste("caption"))).toBeGreaterThan(0);
    }, 20_000);
  }

  // NB: the "attach failure does not wedge the queue" guarantee (C-API-44) is
  // proven deterministically at the control-queue unit level rather than here,
  // where the real 10s chip-confirmation timeout would make the test slow.
});
