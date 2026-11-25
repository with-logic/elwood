/** Keep launch identity, ownership, and socket binding safe during Claude proof (C-API-20/61, C-ATTN-07). */
import { existsSync, mkdirSync, realpathSync, renameSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import * as target from "../../src/claude/workspace-trust/target.ts";
import { type ElwoodDialogEvent, resumeClaude, startClaude } from "../../src/index.ts";
import { claudeComposer, claudeTty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import { trustFrame } from "./workspace-trust-discovery-fixture.ts";

vi.mock("../../src/claude/workspace-trust/target.ts", { spy: true });
afterEach(() => {
  vi.restoreAllMocks();
  resetFakes();
});

async function holdNextProof() {
  const { captureClaudeStartupTrustEvidence } = await vi.importActual<typeof target>(
    "../../src/claude/workspace-trust/target.ts",
  );
  const began = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  vi.mocked(target.captureClaudeStartupTrustEvidence).mockImplementationOnce(async (directory) => {
    began.resolve();
    await release.promise;
    return await captureClaudeStartupTrustEvidence(directory);
  });
  return { began: began.promise, release: release.resolve };
}

async function startResumable(cwd: string) {
  const session = await startClaude({ cwd });
  await ptys[0]!.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "UserPromptSubmit",
    session_id: "existing",
    cwd,
    prompt: "existing conversation",
  });
  return session;
}

function proofBeforeLaunch(proof: Promise<void>, launch: Promise<unknown>) {
  return Promise.race([proof.then(() => "proof"), launch.then(() => "launched")]);
}

test("C-API-20 C-ATTN-07 C-ATTN-08 a resumed Claude session binds and publishes trust after its predecessor stops", async () => {
  installFakes();
  const cwd = realpathSync(tempDir());
  const predecessor = await startResumable(cwd);
  const elwoodSessionId = predecessor.elwoodSessionId;
  const held = await holdNextProof();
  const resumed = resumeClaude({ cwd, elwoodSessionId });
  try {
    expect(await proofBeforeLaunch(held.began, resumed)).toBe("proof");
    expect(ptys).toHaveLength(1);
    await predecessor.stop();
    held.release();
    const successor = await resumed;
    const pty = ptys[1]!;
    const events = vi.fn<(event: ElwoodDialogEvent<"claude">) => void>();
    successor.on("dialog", events);
    pty.emitData(trustFrame(cwd));
    await successor.terminal.settled();
    await expect.poll(() => events.mock.calls.length).toBe(1);
    const requests = await successor.listDialogs();
    expect(requests).toEqual([
      expect.objectContaining({
        elwoodSessionId,
        targetPath: cwd,
        targetScope: "folder",
        choices: [
          expect.objectContaining({ label: "No, exit" }),
          expect.objectContaining({ label: "Yes, I trust this folder" }),
        ],
      }),
    ]);
    const [request] = requests;
    await expect.poll(() => events.mock.calls).toEqual([[{ phase: "raised", request }]]);
    pty.emitData(`\x1b[2J\x1b[H${claudeTty(claudeComposer)}`);
    await successor.terminal.settled();
    await expect
      .poll(() => events.mock.calls.at(-1))
      .toEqual([{ phase: "closed", reason: "cleared", request }]);
    expect(events).toHaveBeenCalledTimes(2);
    expect(pty.writes).toEqual([]);
  } finally {
    held.release();
    const successor = await resumed.catch(() => undefined);
    await successor?.teardown();
    await predecessor.teardown();
  }
});

test("C-API-61 replacing cwd during Claude trust proof leaves state and PTY untouched", async () => {
  installFakes();
  const root = realpathSync(tempDir());
  const cwd = join(root, "workspace");
  const stateDir = join(root, "custom-state");
  mkdirSync(cwd);
  const held = await holdNextProof();
  const starting = startClaude({ cwd, stateDir });
  try {
    expect(await proofBeforeLaunch(held.began, starting)).toBe("proof");
    renameSync(cwd, join(root, "former-workspace"));
    mkdirSync(cwd);
    held.release();
    await expect(starting.then(() => "started")).rejects.toMatchObject({
      code: "claude_start_failed",
      details: { cwd },
    });
    expect(ptys).toHaveLength(0);
    expect(existsSync(stateDir)).toBe(false);
  } finally {
    held.release();
    const session = await starting.catch(() => undefined);
    await session?.teardown();
  }
});

test("C-API-20 a superseded Claude resume cannot recreate cleaned session state", async () => {
  installFakes();
  const cwd = realpathSync(tempDir());
  const first = await startResumable(cwd);
  const elwoodSessionId = first.elwoodSessionId;
  const held = await holdNextProof();
  const older = resumeClaude({ cwd, elwoodSessionId });
  try {
    expect(await proofBeforeLaunch(held.began, older)).toBe("proof");
    const newest = await resumeClaude({ cwd, elwoodSessionId });
    await newest.teardown();
    const sessionDir = join(cwd, ".elwood", "sessions", elwoodSessionId);
    expect(existsSync(sessionDir)).toBe(false);
    held.release();
    await expect(older.then(() => "started")).rejects.toMatchObject({
      code: "session_not_running",
    });
    expect(existsSync(sessionDir)).toBe(false);
  } finally {
    held.release();
    const olderSession = await older.catch(() => undefined);
    await olderSession?.teardown();
    await first.teardown();
  }
});
