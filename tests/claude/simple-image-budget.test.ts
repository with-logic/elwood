/**
 * Mixed-surface image budget through the real `ClaudeSession` facade and the raw session
 * it exposes (PRD §5.3/§5.8, C-API-44): both draw on ONE per-session clone ceiling, and
 * every settle path returns its bytes. Fake PTY + real session machinery; the ceiling is
 * shrunk for the test so it need not allocate the real 200 MiB.
 */

import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { sessionImageBudget } from "../../src/core/images/queued-budget.ts";
import { imageLimits } from "../../src/core/images/types.ts";
import { ClaudeSession } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

const limits = imageLimits as { maxQueuedBytes: number };
const realCeiling = limits.maxQueuedBytes;
afterEach(() => {
  limits.maxQueuedBytes = realCeiling;
  resetFakes();
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const inline = { data: PNG, format: "png" as const };
const imagePastes = () => ptys[0]!.writes.filter((w) => w.endsWith(".png[201~")).length;

test("C-API-44 the facade and its raw session share one queued-image ceiling", async () => {
  limits.maxQueuedBytes = 12; // one 8-byte PNG fits; a second, from EITHER surface, does not
  installFakes();
  const cwd = tempDir();
  const facade = new ClaudeSession({ cwd });
  const live = await facade.start();
  // Not ready yet: the facade submission waits in the control queue holding its clone.
  const held = facade.sendMessage("a", { images: [{ path: join(cwd, "gone.png") }, inline] });
  const heldFailure = expect(held).rejects.toMatchObject({ code: "invalid_image" });
  await expect(live.sendMessage("b", { images: [inline] })).rejects.toMatchObject({
    code: "invalid_image",
  });

  // Release on REJECTION: at dispatch the missing path rejects the facade submission.
  await ptys[0]!.dispatchHook(live.elwoodSessionId, {
    hook_event_name: "InstructionsLoaded",
    session_id: "claude-1",
    cwd,
    file_path: "/tmp/CLAUDE.md",
    memory_type: "Project",
    load_reason: "session_start",
  });
  await heldFailure;
  const raw = live.sendMessage("c", { images: [inline] });
  await vi.waitFor(() => expect(imagePastes()).toBe(1)); // accepted, now mid-attach
  // The reverse direction: a raw reservation bounds both facade entry points.
  await expect(facade.sendMessage("d", { images: [inline] })).rejects.toMatchObject({
    code: "invalid_image",
  });
  await expect(facade.send("e", { images: [inline] })).rejects.toMatchObject({
    code: "invalid_image",
  });

  // Release on SUCCESS: the chip confirms the raw attach, so the facade fits again.
  ptys[0]!.emitData("[999;1H[K❯ [Image #1]");
  await raw;
  // Release on CLOSE: accepted (not `invalid_image`), then rejected by the closing session,
  // after which the whole ceiling is reservable again.
  const last = expect(facade.sendMessage("f", { images: [inline] })).rejects.toMatchObject({
    code: "session_not_running",
  });
  await facade.close();
  await last;
  const budget = sessionImageBudget(live);
  await vi.waitFor(() => expect(() => budget.reserve(12)).not.toThrow());
}, 20_000);
