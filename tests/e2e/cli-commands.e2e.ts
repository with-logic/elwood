/**
 * Compiled-process coverage for the sessions, resume, models, and interactive
 * commands against both real agents.
 * Implements PRD §12A.7-§12A.10 and C-CLI-21 through C-CLI-24.
 */

import assert from "node:assert/strict";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { drivePty, invoke, parse } from "./cli-commands-helpers.ts";
import { e2eTimeoutMs, makeProject, pathRemoved, skipReason, turnsEnabled } from "./helpers.ts";

type SessionsDocument = {
  readonly schemaVersion: 1;
  readonly type: "sessions";
  readonly stateDir: string;
  readonly sessions: readonly {
    readonly id: string;
    readonly agent: "claude" | "codex";
    readonly cwd: string;
    readonly createdAt: string;
    readonly lastUsedAt: string;
    readonly resumable: boolean;
    readonly live: boolean;
  }[];
};
type ModelsDocument = {
  readonly schemaVersion: 1;
  readonly type: "models";
  readonly agent: "claude" | "codex";
  readonly models: readonly {
    readonly id: string;
    readonly isCurrent: boolean;
    readonly isDefault: boolean;
  }[];
};
type ResultDocument = {
  readonly type: "result" | "error";
  readonly response: string;
  readonly sessionId: string | null;
};

const skipTurns = turnsEnabled ? false : "ELWOOD_E2E_SKIP_TURNS=1 disables turn flows";

for (const agent of ["claude", "codex"] as const) {
  test(`C-CLI-21 C-CLI-22 elwood sessions lists a kept real ${agent} session and resume <id> continues it`, {
    skip: skipReason(agent) || skipTurns,
    timeout: e2eTimeoutMs * 2 + 30_000,
  }, async () => {
    const project = makeProject(agent);
    const secret = `harbor-${agent}-5142`;
    const state = `--state-dir=${project.stateDir}`;
    let sessionId: string | null = null;
    try {
      const first = parse<ResultDocument>(
        await invoke(
          [
            `--agent=${agent}`,
            state,
            "--keep",
            "--output=json",
            "--timeout=3m",
            `Remember the code ${secret}. Reply with only remembered.`,
          ],
          project.cwd,
        ),
      );
      assert.equal(first.type, "result");
      assert.ok(first.sessionId);
      sessionId = first.sessionId;

      const listed = parse<SessionsDocument>(
        await invoke(["sessions", state, "--output=json"], tmpdir()),
      );
      assert.equal(listed.type, "sessions");
      assert.equal(listed.stateDir, project.stateDir);
      const record = listed.sessions.find((session) => session.id === sessionId);
      assert.ok(record, JSON.stringify(listed));
      assert.equal(record.agent, agent);
      assert.equal(record.cwd, realpathSync(project.cwd));
      assert.equal(record.resumable, true);
      assert.equal(record.live, false, "no owner is running after the kept run exits");
      assert.ok(Date.parse(record.createdAt) <= Date.parse(record.lastUsedAt));

      const table = await invoke(["sessions", state], tmpdir());
      assert.equal(table.status, 0, table.stderr);
      assert.match(
        table.stdout,
        /^ID\s+AGENT\s+LIVE\s+RESUMABLE\s+LAST USED\s+CREATED\s+WORKSPACE\n/,
      );
      assert.ok(table.stdout.includes(sessionId), table.stdout);

      const resumed = await invoke(
        [
          "resume",
          sessionId,
          state,
          "--timeout=3m",
          "What code did I ask you to remember? Reply with only the code.",
        ],
        tmpdir(),
      );
      assert.equal(resumed.status, 0, resumed.stderr);
      assert.ok(resumed.stdout.includes(secret), resumed.stdout);

      const ephemeral = parse<ResultDocument>(
        await invoke(
          [
            "resume",
            sessionId,
            state,
            "--ephemeral",
            "--output=json",
            "--timeout=3m",
            "Reply with only the remembered code.",
          ],
          tmpdir(),
        ),
      );
      assert.equal(ephemeral.type, "result");
      assert.ok(ephemeral.response.includes(secret), ephemeral.response);
      assert.ok(pathRemoved(project.sessionDir(sessionId)));
      const after = await invoke(["sessions", state], tmpdir());
      assert.equal(after.status, 0);
      assert.equal(after.stdout, "");
      assert.match(after.stderr, /No Elwood sessions in /);
    } finally {
      if (sessionId && existsSync(project.sessionDir(sessionId))) {
        await invoke(
          ["resume", sessionId, state, "--ephemeral", "--output=json", "Discard this session."],
          project.cwd,
        ).catch(() => undefined);
      }
      rmSync(project.cwd, { recursive: true, force: true });
    }
  });

  test(`C-CLI-24 elwood models lists real ${agent} models and leaves no state behind`, {
    skip: skipReason(agent),
    timeout: e2eTimeoutMs + 30_000,
  }, async () => {
    const project = makeProject(agent);
    const state = `--state-dir=${project.stateDir}`;
    try {
      const json = parse<ModelsDocument>(
        await invoke(
          ["models", `--agent=${agent}`, state, "--output=json", "--timeout=2m"],
          project.cwd,
        ),
      );
      assert.equal(json.type, "models");
      assert.equal(json.agent, agent);
      assert.ok(json.models.length >= 2, JSON.stringify(json));
      assert.equal(json.models.filter((model) => model.isCurrent).length, 1);
      assert.ok(json.models.some((model) => model.isDefault));
      const text = await invoke(["models", `--agent=${agent}`, state, "--timeout=2m"], project.cwd);
      assert.equal(text.status, 0, text.stderr);
      assert.match(text.stdout, /^CURRENT\s+ID\s+LABEL\s+DEFAULT\s+DESCRIPTION\n/);
      assert.match(text.stdout, /\n\*\s+\S/);
      assert.ok(text.stdout.includes("(default)"), text.stdout);
      assert.ok(!text.stdout.includes("\u001b"), "table contains terminal escapes");
      const listed = parse<SessionsDocument>(
        await invoke(["sessions", state, "--output=json"], tmpdir()),
      );
      assert.deepEqual(listed.sessions, [], "the models probe tears its identity down");
    } finally {
      rmSync(project.cwd, { recursive: true, force: true });
    }
  });

  test(`C-CLI-23 elwood interactive opens the real ${agent} TUI in a PTY and exits with its status`, {
    skip: skipReason(agent),
    timeout: e2eTimeoutMs + 30_000,
  }, async () => {
    const project = makeProject(agent);
    try {
      const result = await drivePty(agent, project.stateDir, project.cwd);
      assert.equal(result.exitCode, 0, result.output.slice(-2000));
      assert.ok(result.sawComposer, result.output.slice(-2000));
      assert.ok(!existsSync(`${project.stateDir}/sessions`), "interactive writes no Elwood state");
    } finally {
      rmSync(project.cwd, { recursive: true, force: true });
    }
  });
}

test("C-CLI-23 elwood interactive refuses a non-terminal stdin with status 2", async () => {
  const result = await invoke(["interactive", "--agent=codex"], tmpdir());
  assert.equal(result.status, 2);
  assert.match(result.stderr, /interactive requires terminal stdin and stdout/);
});
