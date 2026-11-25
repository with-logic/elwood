/** Drive native Claude trust answers with focused paint and clock control (C-ATTN-07). */
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, vi } from "vitest";
import * as trustEvidence from "../../src/claude/workspace-trust/target.ts";
import { ClaudeSession } from "../../src/index.ts";
import { claudeComposer, claudeTty, tty } from "../fixtures/trust-composer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { claudeWorkspaceTrustScreen } from "../helpers/claude-workspace-trust-screen.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

const sessions: ClaudeSession[] = [];
const capture = (name: string) => capturedFrame(`claude-2.1.310/${name}`).trimEnd();
export const composer = claudeTty(claudeComposer);
export const bypass = capture("bypass-permissions-100");
export const selectYes = "\x1b[H\x1b[B";

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(sessions.splice(0).map((session) => session.teardown()));
  vi.restoreAllMocks();
  resetFakes();
});

export async function setupClaudeAnswer({ repository = false, autotrust = false } = {}) {
  installFakes();
  const root = realpathSync(tempDir());
  const cwd = repository ? join(root, "child") : root;
  if (repository) {
    execFileSync("git", ["-C", root, "init", "-q"]);
    mkdirSync(cwd);
  }
  const captureTrust = trustEvidence.captureClaudeStartupTrustEvidence;
  const beforeProof = vi.fn((): Promise<boolean | undefined> => Promise.resolve(undefined));
  vi.spyOn(trustEvidence, "captureClaudeStartupTrustEvidence").mockImplementation(
    async (launch) => {
      const evidence = await captureTrust(launch);
      if (!evidence) throw new Error("Expected valid launch evidence.");
      return {
        scope: evidence.scope,
        isCurrent: async (signal) => (await beforeProof()) ?? evidence.isCurrent(signal),
      };
    },
  );
  const facade = new ClaudeSession({ cwd, autotrust });
  const session = await facade.start();
  sessions.push(facade);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const pty = ptys[0]!;
  let verifiedAtMs = 0;
  let requestId: string | undefined;
  const render = async (screen: string) => {
    pty.emitData(`\x1b[2J\x1b[H${screen}`);
    await vi.advanceTimersByTimeAsync(10);
  };
  const menu = (selection: "yes" | "no") => tty(claudeWorkspaceTrustScreen(cwd, selection));
  const request = async () => {
    const [request] = await session.listDialogs();
    if (!request) throw new Error("Expected a Claude trust request.");
    if (requestId !== request.id) verifiedAtMs = performance.now();
    requestId = request.id;
    return request;
  };
  const settle = (earlyByMs = 0) =>
    vi.advanceTimersByTimeAsync(Math.max(0, verifiedAtMs + 1_500 - performance.now() - earlyByMs));
  return { root, cwd, facade, session, pty, render, menu, request, settle, beforeProof };
}
