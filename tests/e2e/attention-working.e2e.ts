/** Real approval clearance holds follow-up input during a gated tool (PRD §5.3/§12, C-ATTN-02). */
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { type ElwoodAgentSession, startClaude, startCodex } from "../../src/index.ts";
import { cleanup, makeProject, skipIf, skipReason, skipTurns, waitFor } from "./helpers.ts";

for (const agent of ["claude", "codex"] as const) {
  test(`C-ATTN-02 real ${agent} approval keeps a follow-up queued during tool work`, {
    skip: skipIf(skipReason(agent), skipTurns),
    timeout: 180_000,
  }, async (t) => {
    const project = makeProject(agent);
    const entered = join(project.cwd, "tool-entered");
    const release = join(project.cwd, "tool-release");
    writeFileSync(
      join(project.cwd, "gate.cjs"),
      `
const fs = require('node:fs');
fs.writeFileSync('tool-entered', 'entered');
const deadline = Date.now() + 30000;
const timer = setInterval(() => {
  if (fs.existsSync('tool-release')) { clearInterval(timer); console.log('TOOL_DONE'); }
  else if (Date.now() >= deadline) { clearInterval(timer); process.exitCode = 1; }
}, 50);
`,
    );
    const options = { cwd: project.cwd, stateDir: project.stateDir, autotrust: true };
    const session =
      agent === "claude"
        ? await startClaude({ ...options, permissionMode: "default", tools: ["Bash"] })
        : await startCodex({ ...options, approvalPolicy: "on-request", sandbox: "read-only" });
    const events: ElwoodAgentSession = session;
    const attention: string[] = [];
    events.on("activity", (event) => {
      if (event.kind === "attention") attention.push(event.label);
    });
    try {
      await waitFor(() => session.status === "ready" || undefined, "initial ready", 60_000);
      await session.sendMessage(
        "Run exactly `node gate.cjs` with your shell tool now. It is a local test fixture that " +
          "waits for an external release file. If the sandbox denies its writes, request approval " +
          "for that exact command. Do not read, edit, or bypass it. After it exits, say done.",
      );
      await waitFor(() => session.status === "blocked" || undefined, "tool approval", 60_000);
      assert.ok(
        attention.some((label) =>
          label.includes(`${agent}-${agent === "claude" ? "permission" : "approval"}-dialog`),
        ),
      );
      assert.ok(
        session.terminal.snapshot().text.includes("gate.cjs"),
        "approval names the fixture command",
      );
      let submitted = false;
      const followup = session.sendMessage("Reply only FOLLOWUP_DONE.");
      void followup.then(
        () => {
          submitted = true;
        },
        () => undefined,
      );
      await session.sendKeys(new Uint8Array([0x0d]));
      await waitFor(() => existsSync(entered) || undefined, "approved tool entered", 30_000);
      await waitFor(() => session.status === "running" || undefined, "working clearance", 10_000);
      const statuses: string[] = [];
      events.on("status", (event) => statuses.push(event.status));
      assert.equal(submitted, false, "follow-up remains queued when the approved tool starts");
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(existsSync(release), false, "tool is still held by the fixture");
      assert.equal(session.status, "running");
      assert.equal(submitted, false, "follow-up cannot submit while tool work remains active");
      assert.equal(statuses.includes("ready"), false, "no intermediate ready while tool is held");
      writeFileSync(release, "release");
      await waitFor(() => submitted || undefined, "queued follow-up dispatch after idle", 60_000);
      await followup;
      assert.ok(statuses.includes("ready"), "idle releases the follow-up");
    } catch (error) {
      t.diagnostic(
        JSON.stringify({
          status: session.status,
          screen: session.terminal.snapshot().text.slice(-2000),
        }),
      );
      throw error;
    } finally {
      writeFileSync(release, "release");
      await cleanup(session);
    }
  });
}
