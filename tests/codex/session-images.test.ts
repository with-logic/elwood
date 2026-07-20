/**
 * Conformance tests for Codex image attachment through a real session (PRD §5.3,
 * C-API-44/46): a message with images drives the macOS clipboard + Ctrl+V before
 * the text. The clipboard round-trip is real (macOS-gated); the invalid-image and
 * unsupported-platform rejections are covered hermetically in the unit tests.
 */

import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

const isMac = process.platform === "darwin";
const sample = join(import.meta.dirname, "..", "fixtures", "sample.png");
const CTRL_V = String.fromCharCode(22);

describe("CodexSession image attachment (C-API-44/46)", () => {
  test.runIf(isMac)("C-API-46 sends Ctrl+V per image, then the text, in one turn", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    const queued = session.sendMessage("describe", { images: [{ path: sample }] });
    await becomeReady(session.elwoodSessionId, cwd);
    // The chip appears once Codex ingests the clipboard image; emit it after the
    // Ctrl+V lands so the attach wait observes the count increase and resolves.
    const tick = () => {
      if (ptys[0]!.writes.includes(CTRL_V)) ptys[0]!.emitData("[Image #1]");
      else setTimeout(tick, 20);
    };
    setTimeout(tick, 20);
    await queued;
    const writes = ptys[0]!.writes;
    expect(writes[0]).toBe(CTRL_V); // clipboard image pasted first
    expect(writes).toContain("[200~describe[201~");
    expect(writes.indexOf("[200~describe[201~")).toBeGreaterThan(0);
  });

  test("C-API-44 an unreadable image rejects the whole submission", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    const promise = session.sendMessage("x", { images: [{ path: join(cwd, "missing.png") }] });
    await expect(promise).rejects.toMatchObject({ code: "invalid_image" });
    await becomeReady(session.elwoodSessionId, cwd);
    expect(ptys[0]!.writes).toEqual([]);
  });
});
