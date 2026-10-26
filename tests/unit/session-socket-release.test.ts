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

afterEach(() => {
  claude.resetFakes();
  codex.resetFakes();
  resetSocketHomeRootForTests();
  if (privateRoot) rmSync(privateRoot, { recursive: true, force: true });
  privateRoot = undefined;
});

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
    start: (cwd: string) => startClaude({ cwd }),
    resume: (id: string, cwd: string) => resumeClaude({ elwoodSessionId: id, cwd }),
    // Persists the resume id, so a later resume of the session can launch.
    ready: (id: string, cwd: string) =>
      claude.ptys[0]!.dispatchHook(id, {
        hook_event_name: "SessionStart",
        session_id: "claude-release",
        cwd,
        source: "startup",
      }),
  },
  {
    agent: "codex",
    helpers: codex,
    start: (cwd: string) => startCodex({ cwd }),
    resume: (id: string, cwd: string) => resumeCodex({ elwoodSessionId: id, cwd }),
    ready: (id: string, cwd: string) => codex.becomeReady(id, cwd),
  },
] as const;

for (const { agent, helpers, start, resume, ready } of adapters) {
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
      await ready(first.elwoodSessionId, cwd);
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
