/**
 * A resumed Codex session reaches ready on its first configured composer, not on a bare
 * composer marker, and without waiting for `SessionStart`. Covers PRD §5.3 and C-API-28.
 */

import { afterEach, expect, test } from "vitest";
import { resumeCodex, startCodex } from "../../src/index.ts";
import { codexComposer, codexTty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("C-API-28 resume reaches ready on the first configured composer (no SessionStart needed)", async () => {
  const cwd = tempDir();
  installFakes();
  const session = await startCodex({ cwd });
  await ptys[0]!.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "SessionStart",
    session_id: "codex-session-1",
    cwd,
    model: "gpt-5.3-codex",
    source: "startup",
  });
  await session.stop();
  // Resume, then render composer frames WITHOUT dispatching SessionStart (the CLI does not
  // re-fire it on resume). A bare composer marker is not enough: the resume placeholder and
  // an unrecognized menu's selected row carry it too. The configured composer is, so the
  // session reaches ready without waiting out the deadline.
  const resumed = await resumeCodex({ cwd, elwoodSessionId: session.elwoodSessionId });
  const render = async (frame: string) => {
    ptys[1]!.emitData(`\u001b[2J\u001b[H${frame}`);
    await resumed.terminal.settled(); // flush the write -> render -> readiness chain
    await new Promise((r) => setImmediate(r));
  };
  await render("› ");
  expect(resumed.status).not.toBe("ready");
  await render(codexTty(codexComposer));
  expect(resumed.status).toBe("ready");
});
