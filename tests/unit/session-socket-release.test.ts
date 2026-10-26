/**
 * Conformance tests for releasing a session's socket home when a launch ends without
 * teardown (PRD §8.1, C-STATE-12): `stop`, `kill`, and the agent exiting on its own remove
 * the launch's socket file and then the home it emptied, so a session that is never torn
 * down leaves nothing in the OS temp dir. A launch that ends while an overlapping launch
 * of the same session is live keeps the home that launch's socket is in. Both adapters
 * run their real hook bridges, with socket homes under a short private root (see the
 * socket-leak suites for why the root is short and scoped to the socket-home module).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { resumeClaude, resumeCodex, startClaude, startCodex } from "../../src/index.ts";
import {
  resetSocketHomeRootForTests,
  setSocketHomeRootForTests,
} from "../../src/state/socket-home.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";
import { socketFilesIn, socketHomesIn } from "../helpers/socket-leak.ts";

let privateRoot: string | undefined;
const started: { teardown(): Promise<void> }[] = [];

afterEach(async () => {
  // Even a test that failed before its own stop closes every bridge it started, before the
  // seams are reset and the root holding their sockets is removed.
  await Promise.allSettled(started.splice(0).map((session) => session.teardown()));
  claude.resetFakes();
  codex.resetFakes();
  resetSocketHomeRootForTests();
  if (privateRoot) rmSync(privateRoot, { recursive: true, force: true });
  privateRoot = undefined;
});

/** `session`, torn down after the test however it ends. */
function tracked<T extends { teardown(): Promise<void> }>(session: T): T {
  started.push(session);
  return session;
}

/** Mints socket homes under a short private root, so the bound path clears macOS's cap. */
function isolateSocketHomes(): string {
  privateRoot = mkdtempSync("/tmp/elwood-sockhome-");
  setSocketHomeRootForTests(privateRoot);
  return privateRoot;
}

const adapters = [
  {
    agent: "claude",
    helpers: claude,
    start: async (cwd: string) => tracked(await startClaude({ cwd })),
    resume: async (elwoodSessionId: string, cwd: string) =>
      tracked(await resumeClaude({ elwoodSessionId, cwd })),
    // SessionStart records the agent's session id, so a later resume of the session can launch.
    recordAgentSessionId: (elwoodSessionId: string, cwd: string) =>
      claude.ptys[0]!.dispatchHook(elwoodSessionId, {
        hook_event_name: "SessionStart",
        session_id: "claude-release",
        cwd,
        source: "startup",
      }),
  },
  {
    agent: "codex",
    helpers: codex,
    start: async (cwd: string) => tracked(await startCodex({ cwd })),
    resume: async (elwoodSessionId: string, cwd: string) =>
      tracked(await resumeCodex({ elwoodSessionId, cwd })),
    // Records the agent's session id the same way, and also marks the session ready.
    recordAgentSessionId: (elwoodSessionId: string, cwd: string) =>
      codex.becomeReady(elwoodSessionId, cwd),
  },
] as const;

for (const { agent, helpers, start, resume, recordAgentSessionId } of adapters) {
  describe(`${agent} socket home release`, () => {
    test.each([
      "stop",
      "kill",
    ] as const)(`C-STATE-12 ${agent} %s removes the socket home it emptied`, async (verb) => {
      helpers.installFakes();
      const cwd = helpers.tempDir();
      const root = isolateSocketHomes();
      const session = await start(cwd);
      expect(socketFilesIn(root)).toHaveLength(1);
      await session[verb]();
      expect(socketHomesIn(root)).toEqual([]);
    });

    test(`C-STATE-12 ${agent} exiting on its own removes the socket home it emptied`, async () => {
      helpers.installFakes();
      const cwd = helpers.tempDir();
      const root = isolateSocketHomes();
      await start(cwd);
      expect(socketFilesIn(root)).toHaveLength(1);
      helpers.ptys[0]!.emitExit({ exitCode: 0 });
      await expect.poll(() => socketHomesIn(root)).toEqual([]);
    });

    test(`C-STATE-12 ${agent} stop keeps the home a live overlapping launch's socket is in`, async () => {
      helpers.installFakes();
      const cwd = helpers.tempDir();
      const root = isolateSocketHomes();
      const first = await start(cwd);
      await recordAgentSessionId(first.elwoodSessionId, cwd);
      const second = await resume(first.elwoodSessionId, cwd); // overlaps the live first
      expect(socketHomesIn(root)).toHaveLength(1);
      expect(socketFilesIn(root)).toHaveLength(2);
      await first.stop();
      expect(socketFilesIn(root)).toHaveLength(1); // the overlapping launch's socket stays
      await second.stop();
      expect(socketHomesIn(root)).toEqual([]);
    });
  });
}
