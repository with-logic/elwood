/** Isolated real session runtimes with synthetic CLI producers (PRD §4.1/§9.2). */
// biome-ignore-all lint/suspicious/noMisplacedAssertion: Executable benchmark correctness checks.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElwoodAgentSession } from "../../../src/core/agent-session.ts";
import { startClaude, startCodex } from "../../../src/index.ts";
import { setCommandRunnerForTests, setPtyFactoryForTests } from "../../../src/runtime/seams.ts";
import { setGroupKillerForTests } from "../../../src/runtime/shutdown/reap-tree.ts";
import { setStartupWaitMsForTests } from "../../../src/runtime/startup/index.ts";
import { FakePty } from "../../../tests/helpers/fake-pty.ts";

/** Installs standalone-process test seams and returns sessions/producers in an owned temp root.
 * The caller must await dispose() to tear down every runtime and remove its files/socket homes.
 */
export async function createFleet(count: number) {
  const root = mkdtempSync(join(tmpdir(), "elwood_fleet_bench-"));
  const ptys = new Map<string, FakePty>();
  const sessions: ElwoodAgentSession[] = [];
  setStartupWaitMsForTests(1);
  setGroupKillerForTests({
    killGroup() {
      /* Producer PIDs are synthetic; never signal user processes. */
    },
  });
  setCommandRunnerForTests((command, args) => ({
    status: 0,
    stdout: args.join(" ").includes("--help")
      ? "codex --dangerously-bypass-hook-trust\n"
      : `${[command, ...args].join(" ").includes("codex") ? "codex-cli 0.163.0" : "2.1.305"}\n`,
    stderr: "",
  }));
  setPtyFactoryForTests((options) => {
    const pty = new FakePty(options, 900_000 + ptys.size);
    ptys.set(options.cwd, pty);
    return pty;
  });
  try {
    for (let index = 0; index < count; index++) {
      const cwd = join(root, String(index));
      mkdirSync(cwd);
      const path = join(cwd, "transcript.jsonl");
      writeFileSync(path, "");
      const options = {
        cwd,
        stateDir: join(root, "state"),
        autotrust: true,
        autoupdate: false,
        initialSize: { cols: 120, rows: 40 },
      };
      const session = index % 2 === 0 ? await startClaude(options) : await startCodex(options);
      sessions.push(session);
      const pty = ptys.get(cwd)!;
      const reply = await pty.dispatchHook(
        session.elwoodSessionId,
        {
          hook_event_name: index % 2 === 0 ? "InstructionsLoaded" : "SessionStart",
          session_id: `fleet-${index}`,
          cwd,
          transcript_path: path,
          model: "synthetic-no-model",
          source: "startup",
          file_path: join(cwd, "CLAUDE.md"),
          memory_type: "Project",
          load_reason: "session_start",
        },
        options.stateDir,
      );
      assert.equal(reply.exitCode, 0);
      assert.equal(session.status, "ready");
    }
    return {
      root,
      sessions,
      pty: (session: ElwoodAgentSession) => ptys.get(session.cwd)!,
      async dispose() {
        try {
          await teardownFleet(sessions, root);
        } finally {
          ptys.clear();
          sessions.length = 0;
        }
      },
    };
  } catch (error) {
    try {
      await teardownFleet(sessions, root);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Fleet startup and cleanup failed.");
    }
    throw error;
  }
}

/** Waits for every teardown before removing shared files, retaining all shutdown failures. */
async function teardownFleet(sessions: readonly ElwoodAgentSession[], root: string): Promise<void> {
  const outcomes = await Promise.allSettled(sessions.map((session) => session.teardown()));
  rmSync(root, { recursive: true, force: true });
  const errors = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : [],
  );
  if (errors.length > 0) throw new AggregateError(errors, "Fleet teardown failed.");
}
