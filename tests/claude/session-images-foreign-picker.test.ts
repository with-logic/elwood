/** Image attachment respects foreign model-picker ownership (PRD §5.3, C-API-44). */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

const attachment = { entered: false };
vi.mock("../../src/claude/attach-images.ts", async (original) => {
  const actual = await original<typeof import("../../src/claude/attach-images.ts")>();
  return {
    ...actual,
    attachClaudeImages: (...args: Parameters<typeof actual.attachClaudeImages>) => {
      attachment.entered = true;
      return actual.attachClaudeImages(...args);
    },
  };
});

const { startClaude } = await import("../../src/index.ts");
const { installFakes, ptys, resetFakes, tempDir } = await import("./helpers.ts");

import { asScreen, claudePicker } from "../helpers/model-pickers.ts";

afterEach(() => {
  resetFakes();
  attachment.entered = false;
});

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const paste = (text: string) => `\u001b[200~${text}\u001b[201~`;

test("C-API-44 image and text writes wait for a foreign model picker to close", async () => {
  installFakes();
  const cwd = tempDir();
  const image = join(cwd, "shot.png");
  writeFileSync(image, png);
  const session = await startClaude({ cwd });
  try {
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "InstructionsLoaded",
      session_id: "claude-1",
      cwd,
      file_path: "/tmp/CLAUDE.md",
      memory_type: "Project",
      load_reason: "session_start",
    });
    await expect.poll(() => session.status).toBe("ready");
    ptys[0]!.emitData(asScreen(claudePicker));
    await session.terminal.settled();
    const sent = session.sendMessage("caption", { images: [{ path: image }] });
    void sent.catch(() => undefined);
    // The wrapper observes entry, then runs the real attachment implementation.
    await expect.poll(() => attachment.entered).toBe(true);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(ptys[0]!.writes).toEqual([]);
    ptys[0]!.emitData(
      asScreen(
        "Claude Code v2.1.278\n────────\n❯ \n────────\n  -- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
      ),
    );
    await session.terminal.settled();
    await expect.poll(() => ptys[0]!.writes).toEqual([paste(image)]);
    ptys[0]!.emitData("\u001b[999;1H\u001b[K❯ [Image #1]");
    await sent;
    expect(ptys[0]!.writes).toEqual([paste(image), paste("caption"), "\r"]);
  } finally {
    await session.stop();
  }
});
