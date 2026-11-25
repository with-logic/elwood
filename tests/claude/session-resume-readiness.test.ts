/**
 * A resumed Claude session releases queued input on its verified idle composer, never on
 * a bare `❯` marker. Covers PRD §5.3 and C-API-28.
 */

import { afterEach, expect, test } from "vitest";
import { resumeClaude, startClaude } from "../../src/index.ts";
import { claudeComposer, claudeTty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("C-API-28 a resumed Claude holds queued input on a bare marker until its idle composer", async () => {
  installFakes();
  const cwd = tempDir();
  const original = await startClaude({ cwd });
  await ptys[0]!.dispatchHook(original.elwoodSessionId, {
    hook_event_name: "UserPromptSubmit",
    session_id: "claude-resume",
    cwd,
    prompt: "existing conversation",
    model: "fixture",
  });
  await original.stop();
  const session = await resumeClaude({ cwd, elwoodSessionId: original.elwoodSessionId });
  try {
    const queued = session.sendMessage("queued at resume");
    const render = async (frame: string) => {
      ptys[1]!.emitData(`\u001b[2J\u001b[H${frame}`);
      await session.terminal.settled();
      await new Promise((r) => setImmediate(r));
    };
    await render("❯ ");
    expect(session.status).not.toBe("ready");
    expect(ptys[1]!.writes).toEqual([]);
    await render(claudeTty(claudeComposer));
    await queued;
    expect(ptys[1]!.writes.join("")).toContain("queued at resume");
  } finally {
    await session.stop();
  }
});
