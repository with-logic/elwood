/**
 * Compiled-process coverage for the sessions, resume, models, and interactive
 * commands against both real agents.
 * Implements PRD §12A.7-§12A.10 and C-CLI-23 through C-CLI-26.
 */

import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  codexDefaultSandbox,
  defaultRowIds,
  drivePty,
  invoke,
  type ModelsDocument,
  type PtyRun,
  parse,
  type ResultDocument,
  type SessionsDocument,
} from "./cli-commands-helpers.ts";
import { cliScratch } from "./cli-commands-scratch.ts";
import {
  e2eTimeoutMs,
  makeProject,
  pathRemoved,
  sandboxedCodexHome,
  skipReason,
  turnsEnabled,
} from "./helpers.ts";

const skipTurns = turnsEnabled ? false : "ELWOOD_E2E_SKIP_TURNS=1 disables turn flows";

for (const agent of ["claude", "codex"] as const) {
  test(`C-CLI-23 C-CLI-24 elwood sessions lists a default-kept real ${agent} session and resume <id> continues it`, {
    skip: skipReason(agent) || skipTurns,
    timeout: e2eTimeoutMs * 2 + 30_000,
  }, async () => {
    const project = makeProject(agent);
    const secret = `harbor-${agent}-5142`;
    const state = `--state-dir=${project.stateDir}`;
    const sandbox = agent === "codex" ? sandboxedCodexHome(project, "") : undefined;
    const scratch = cliScratch(project, sandbox);
    let sessionId: string | null = null;
    // The discard runs inside the body, so its own launch counts before the scratch goes.
    await scratch.end(async () => {
      try {
        const first = parse<ResultDocument>(
          await scratch.run(
            [
              `--agent=${agent}`,
              state,
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

        const resumed = await scratch.run(
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
          await scratch.run(
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
          const discard = ["resume", sessionId, state, "--ephemeral", "--output=json", "Discard."];
          await scratch.run(discard, project.cwd).catch(() => undefined);
        }
      }
    });
  });

  test(`C-CLI-26 elwood models lists real ${agent} models and leaves no state behind`, {
    skip: skipReason(agent),
    timeout: e2eTimeoutMs + 30_000,
  }, async () => {
    const project = makeProject(agent);
    const state = `--state-dir=${project.stateDir}`;
    const codexHome = agent === "codex" ? codexDefaultSandbox(project) : undefined;
    const scratch = cliScratch(project, codexHome?.sandbox);
    const models = (...args: string[]) =>
      scratch.run(["models", `--agent=${agent}`, state, ...args], project.cwd);
    await scratch.end(async () => {
      const json = parse<ModelsDocument>(await models("--output=json", "--timeout=2m"));
      assert.equal(json.type, "models");
      assert.equal(json.agent, agent);
      assert.ok(json.models.length >= 2, JSON.stringify(json));
      assert.equal(json.models.filter((model) => model.isCurrent).length, 1);
      const expectedDefault = codexHome
        ? codexHome.configureDefault(json.models)
        : json.models.find((model) => model.isDefault)?.id;
      assert.ok(expectedDefault, JSON.stringify(json));
      const text = await models("--timeout=2m");
      assert.equal(text.status, 0, text.stderr);
      assert.match(text.stdout, /^CURRENT\s+ID\s+LABEL\s+DEFAULT\s+DESCRIPTION\n/);
      assert.match(text.stdout, /\n\*\s+\S/);
      assert.deepEqual(defaultRowIds(text.stdout), [expectedDefault], text.stdout);
      assert.ok(!text.stdout.includes("\u001b"), "table contains terminal escapes");
      const listed = parse<SessionsDocument>(
        await invoke(["sessions", state, "--output=json"], tmpdir()),
      );
      assert.deepEqual(listed.sessions, [], "the models probe tears its identity down");
    });
  });

  test(`C-CLI-25 elwood interactive opens the real ${agent} TUI in a PTY and exits with its status`, {
    skip: skipReason(agent),
    timeout: e2eTimeoutMs + 30_000,
  }, async () => {
    const project = makeProject(agent);
    const scratch = cliScratch(
      project,
      agent === "codex" ? sandboxedCodexHome(project, "") : undefined,
    );
    await scratch.end(async () => {
      // Interactive mode exits with the agent's status: only 0 confirms Codex is gone.
      const exited = (run: PtyRun) =>
        run.exitCode === 0 ? run : Promise.reject(new Error(run.output.slice(-2000)));
      const result = await scratch.track(
        drivePty(agent, project.stateDir, project.cwd).then(exited),
      );
      assert.ok(result.sawComposer, result.output.slice(-2000));
      assert.ok(!existsSync(`${project.stateDir}/sessions`), "interactive writes no Elwood state");
    });
  });
}

test("C-CLI-25 elwood interactive refuses a non-terminal stdin with status 2", async () => {
  const result = await invoke(["interactive", "--agent=codex"], tmpdir());
  assert.equal(result.status, 2);
  assert.match(result.stderr, /interactive requires terminal stdin and stdout/);
});
