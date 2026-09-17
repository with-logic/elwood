/** Real compiled-CLI session-ID output for both adapters (PRD §12A.3, C-CLI-27). */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import { sessionSocketHome } from "../../src/state/socket-home.ts";
import { invoke, parse } from "./cli-commands-helpers.ts";
import { e2eTimeoutMs, makeProject, skipIf, skipReason, skipTurns } from "./helpers.ts";

type Listed = { readonly sessions: readonly { readonly id: string }[] };
type Result = {
  readonly schemaVersion: number;
  readonly type: string;
  readonly agent: string;
  readonly response: string;
  readonly sessionId: string | null;
};

for (const agent of ["claude", "codex"] as const) {
  test(`C-CLI-27 real ${agent} keeps text quiet and opts into IDs without changing JSON/JSONL`, {
    skip: skipIf(skipReason(agent), skipTurns),
    timeout: e2eTimeoutMs * 5 + 30_000,
  }, async () => {
    const project = makeProject(agent);
    const common = ["--no-defaults", `--state-dir=${project.stateDir}`, "--timeout=3m"];
    const prompt = "Reply with exactly elwood-session-id-ok and nothing else. Do not use tools.";
    const ids: string[] = [];
    try {
      const quiet = await invoke([`--agent=${agent}`, ...common, prompt], project.cwd);
      assert.equal(quiet.status, 0, quiet.stderr);
      assert.match(quiet.stdout, /elwood-session-id-ok/);
      assert.equal(quiet.stderr, "");
      assert.doesNotMatch(quiet.stdout, /elwood: session/);
      const listed = parse<Listed>(
        await invoke(
          ["sessions", "--no-defaults", `--state-dir=${project.stateDir}`, "--output=json"],
          project.cwd,
        ),
      );
      assert.equal(listed.sessions.length, 1);
      const firstId = listed.sessions[0]!.id;
      ids.push(firstId);

      const resumed = await invoke(
        ["resume", firstId, ...common, "--show-session-id", prompt],
        project.cwd,
      );
      assert.equal(resumed.status, 0, resumed.stderr);
      assert.match(resumed.stdout, /elwood-session-id-ok/);
      assert.equal(resumed.stderr, `elwood: session ${firstId}\n`);
      assert.doesNotMatch(resumed.stdout, /elwood: session/);

      const shown = await invoke(
        [`--agent=${agent}`, ...common, "--show-session-id", prompt],
        project.cwd,
      );
      assert.equal(shown.status, 0, shown.stderr);
      assert.match(shown.stdout, /elwood-session-id-ok/);
      const match = /^elwood: session ([0-9a-f-]+)\n$/.exec(shown.stderr);
      assert.ok(match, shown.stderr);
      const shownId = match[1]!;
      ids.push(shownId);

      for (const output of ["json", "jsonl"]) {
        const result = await invoke(
          ["resume", shownId, ...common, "--show-session-id", `--output=${output}`, prompt],
          project.cwd,
        );
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, "");
        const records: Result[] =
          output === "json"
            ? [JSON.parse(result.stdout)]
            : result.stdout
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));
        const terminal = records.filter((record) => record.type === "result");
        assert.equal(terminal.length, 1);
        assert.equal(terminal[0]!.schemaVersion, 1);
        assert.equal(terminal[0]!.agent, agent);
        assert.equal(terminal[0]!.sessionId, shownId);
        assert.match(terminal[0]!.response, /elwood-session-id-ok/);
        assert.doesNotMatch(result.stdout, /elwood: session/);
      }
    } finally {
      for (const id of ids) {
        rmSync(
          sessionSocketHome({ stateDir: project.stateDir, elwoodSessionId: id, adapter: agent }),
          {
            recursive: true,
            force: true,
          },
        );
      }
      rmSync(project.cwd, { recursive: true, force: true });
    }
  });
}
