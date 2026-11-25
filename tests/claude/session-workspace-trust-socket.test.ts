/** Verify a pending trust proof leaves the successor bridge usable (C-API-20, C-ATTN-07). */
import { realpathSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import * as target from "../../src/claude/workspace-trust/target.ts";
import { resumeClaude, startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

vi.mock("../../src/claude/workspace-trust/target.ts", { spy: true });
afterEach(() => {
  vi.restoreAllMocks();
  resetFakes();
});

test("C-API-20 the successor bridge binds when its predecessor stops during workspace proof", async () => {
  installFakes();
  const cwd = realpathSync(tempDir());
  const predecessor = await startClaude({ cwd });
  const elwoodSessionId = predecessor.elwoodSessionId;
  await ptys[0]!.dispatchHook(elwoodSessionId, {
    hook_event_name: "UserPromptSubmit",
    session_id: "existing",
    cwd,
    prompt: "existing conversation",
  });
  const began = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  vi.mocked(target.captureClaudeStartupTrustEvidence).mockImplementationOnce(async () => {
    began.resolve();
    await release.promise;
    return undefined;
  });
  const resumed = resumeClaude({ cwd, elwoodSessionId });
  try {
    await Promise.race([began.promise, resumed]);
    await predecessor.stop();
    release.resolve();
    await expect(resumed).resolves.toMatchObject({ elwoodSessionId });
  } finally {
    release.resolve();
    const successor = await resumed.catch(() => undefined);
    await successor?.teardown();
    await predecessor.teardown();
  }
});
