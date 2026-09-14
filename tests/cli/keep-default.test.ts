/** Default CLI retention through argument resolution and cleanup (PRD §12A.2, C-CLI-08). */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { parseCliArgs } from "../../src/cli/args/index.ts";
import { finalizeRunRequest, resolveRunRequest } from "../../src/cli/request/index.ts";
import { executeRun } from "../../src/cli/run/index.ts";
import { AsyncOutputSink } from "../../src/cli/stream.ts";
import { FakeCliSession, FakeSignals, MemoryWriter } from "./run-fakes.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function* stdin(): AsyncGenerator<string> {}

test.each([
  { flags: [], keep: true },
  { flags: ["--keep"], keep: true },
  { flags: ["--ephemeral"], keep: false },
  { flags: ["--resume", "s1"], keep: true },
  { flags: ["--resume", "s1", "--keep"], keep: true },
  { flags: ["--resume", "s1", "--ephemeral"], keep: false },
])("C-CLI-08 resolves retention and cleanup for $flags", async ({ flags, keep }) => {
  const root = mkdtempSync(join(tmpdir(), "elwood-retention-"));
  roots.push(root);
  const parsed = parseCliArgs(["--agent", "codex", "--output", "json", ...flags, "go"]);
  if (parsed.command !== "run") throw new Error("expected run");
  const draft = await resolveRunRequest(parsed, {
    env: {},
    homeDir: root,
    invocationCwd: root,
    stdin: { isTTY: true, source: stdin() },
  });
  expect(draft.keep).toBe(keep);
  expect(draft.ephemeral).toBe(!keep);
  const request = await finalizeRunRequest(
    draft,
    draft.resume === undefined ? undefined : { agent: "codex", cwd: root },
  );
  const session = new FakeCliSession();
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  expect(
    await executeRun(
      request,
      session,
      {
        stdout: new AsyncOutputSink(stdout),
        stderr: new AsyncOutputSink(stderr),
      },
      { signals: new FakeSignals() },
    ),
  ).toBe(0);
  expect(JSON.parse(stdout.value)).toMatchObject({
    sessionId: keep ? "s1" : null,
    cleanup: { action: keep ? "preserve" : "teardown", status: "succeeded" },
  });
  expect(session.teardowns).toBe(keep ? 0 : 1);
});
