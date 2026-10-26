/**
 * A workspace another user could replace fails a new run and an exact resume through the CLI
 * entry with status 2, before its state root or adapter is touched (PRD §12A.5, C-CLI-15,
 * C-CLI-17).
 */

import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { main } from "../../src/cli/main.ts";
import { finalizeRunRequest } from "../../src/cli/request/index.ts";
import { prepareCliSession } from "../../src/cli/session/index.ts";
import type { ResolvedRunRequest } from "../../src/cli/types.ts";
import {
  ensurePrivateStateRoot,
  readPrivateSessionRecord,
} from "../../src/state/private-session.ts";
import { createSessionRecord, sessionDir, writeSessionRecord } from "../../src/state/store.ts";
import { tempDir } from "../helpers/tmp.ts";
import { mainDependencies, mainHarness, resolvedRequest } from "./main-fakes.ts";

/** A workspace in a directory anyone can write, and the CLI's private state elsewhere. */
function replaceableWorkspace() {
  const base = tempDir();
  const shared = join(base, "shared");
  const cwd = join(shared, "ws");
  mkdirSync(cwd, { recursive: true });
  chmodSync(shared, 0o777);
  // The refusal names the directory as the walk reached it, through the temp directory's links.
  return { cwd, shared: realpathSync(shared), stateDir: join(base, "state") };
}

/**
 * Runs `elwood go` resolved to `request`, with the real session preparation and a run that
 * starts the session, so a workspace that passed would reach the recorded launch steps.
 */
async function runCli(request: ResolvedRunRequest) {
  const touched: string[] = [];
  const step = (name: string) => () => {
    touched.push(name);
    return Promise.reject(new Error(name));
  };
  const h = mainHarness();
  const status = await main(
    ["go"],
    h.context,
    mainDependencies({
      resolve: () => Promise.resolve(request),
      prepare: (draft) =>
        prepareCliSession(draft, {
          randomId: () => "new-session",
          readRecord: readPrivateSessionRecord,
          finalize: finalizeRunRequest,
          launch: {
            prepareStateRoot: () => void touched.push("prepareStateRoot"),
            startClaude: step("startClaude"),
            resumeClaude: step("resumeClaude"),
            startCodex: step("startCodex"),
            resumeCodex: step("resumeCodex"),
          },
        }),
      execute: async (_request, session) => {
        await session.start();
        return 0;
      },
    }),
  );
  return { status, stderr: h.stderr.value, touched };
}

/** The refusal, with the fix PRD §12A.5 requires it to name. */
const refusal = (cwd: string, shared: string) =>
  `elwood: Workspace '${cwd}' could be replaced by another user: directory '${shared}' is writable by other users; remove that with 'chmod go-w', or choose a workspace elsewhere.`;

test("C-CLI-15 C-CLI-17 a new run in a replaceable workspace fails with status 2", async () => {
  const { cwd, shared, stateDir } = replaceableWorkspace();
  const result = await runCli(resolvedRequest({ cwd, stateDir }));
  expect(result.status).toBe(2);
  expect(result.stderr).toContain(refusal(cwd, shared));
  expect(result.touched).toEqual([]);
});

test("C-CLI-15 C-CLI-17 a resume whose stored workspace is replaceable fails with status 2", async () => {
  const { cwd, shared, stateDir } = replaceableWorkspace();
  ensurePrivateStateRoot(stateDir, cwd);
  writeSessionRecord(
    createSessionRecord({ cwd, id: "saved", adapter: "claude" }),
    sessionDir(stateDir, "saved"),
  );
  // A resume takes its workspace from the record, so the request carries none.
  const { cwd: _none, ...resume } = resolvedRequest({ resume: "saved", stateDir });
  const result = await runCli(resume);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain(refusal(cwd, shared));
  expect(result.touched).toEqual([]);
});
