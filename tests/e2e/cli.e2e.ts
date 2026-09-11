/**
 * Compiled-process smoke coverage for the headless CLI against both real agents.
 * Implements PRD §12A and C-E2E-19/C-CLI-01/C-CLI-10 through C-CLI-12.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sessionSocketHome } from "../../src/state/socket-home.ts";
import {
  e2eTimeoutMs,
  makeProject,
  pathRemoved,
  skipIf,
  skipReason,
  skipTurns,
} from "./helpers.ts";

type Invocation = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};
type TerminalDocument = {
  readonly type: "result" | "error";
  readonly agent: "claude" | "codex";
  readonly response: string;
  readonly sessionId: string | null;
  readonly cleanup: { readonly action: "none" | "preserve" | "teardown" };
  readonly error?: { readonly code: string };
};

const entryPath = fileURLToPath(new URL("../../dist/cli/entry.js", import.meta.url));

for (const agent of ["claude", "codex"] as const) {
  test(`C-E2E-19 elwood emits clean final text through real ${agent}`, {
    skip: skipIf(skipReason(agent), skipTurns),
    timeout: e2eTimeoutMs + 30_000,
  }, async () => {
    const project = makeProject(agent);
    const token = `elwood-cli-${agent}-ok`;
    try {
      const result = await invoke(
        [
          `--agent=${agent}`,
          `--state-dir=${project.stateDir}`,
          "--timeout=3m",
          `Reply with exactly ${token} and nothing else.`,
        ],
        project.cwd,
      );
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes(token), result.stdout);
      assert.ok(!result.stdout.includes("\u001b"), "stdout contains terminal escapes");
      assert.doesNotMatch(result.stdout, /esc to interrupt|tokens left|bypass permissions/iu);
    } finally {
      rmSync(project.cwd, { recursive: true, force: true });
    }
  });

  test(`C-E2E-19 elwood keeps and resumes real ${agent} across processes`, {
    skip: skipIf(skipReason(agent), skipTurns),
    timeout: e2eTimeoutMs * 2 + 30_000,
  }, async () => {
    const project = makeProject(agent);
    const secret = `cedar-${agent}-7319`;
    let sessionId: string | null = null;
    try {
      const first = parse(
        await invoke(
          [
            `--agent=${agent}`,
            `--state-dir=${project.stateDir}`,
            "--keep",
            "--output=json",
            "--timeout=3m",
            `Remember the code ${secret}. Reply with only remembered.`,
          ],
          project.cwd,
        ),
      );
      assert.equal(first.type, "result");
      assert.equal(first.agent, agent);
      assert.equal(first.cleanup.action, "preserve");
      assert.ok(first.sessionId);
      sessionId = first.sessionId;

      const resumed = parse(
        await invoke(
          [
            `--state-dir=${project.stateDir}`,
            `--resume=${sessionId}`,
            "--ephemeral",
            "--output=json",
            "--timeout=3m",
            "What code did I ask you to remember? Reply with only the code.",
          ],
          tmpdir(),
        ),
      );
      assert.equal(resumed.type, "result");
      assert.equal(resumed.agent, agent);
      assert.ok(resumed.response.includes(secret), resumed.response);
      assert.equal(resumed.cleanup.action, "teardown");
      assert.ok(pathRemoved(project.sessionDir(sessionId)));
    } finally {
      // If the resume never tore the kept session down, remove its state and the
      // socket home teardown would have removed — no model turn just for cleanup.
      if (sessionId && !pathRemoved(project.sessionDir(sessionId))) {
        rmSync(project.sessionDir(sessionId), { recursive: true, force: true });
        const home = sessionSocketHome({
          stateDir: project.stateDir,
          elwoodSessionId: sessionId,
          adapter: agent,
        });
        rmSync(home, { recursive: true, force: true });
      }
      rmSync(project.cwd, { recursive: true, force: true });
    }
  });
}

test("C-E2E-19 elwood fails closed on a declined Claude workspace trust gate", {
  skip: skipIf(skipReason("claude")),
  timeout: e2eTimeoutMs + 30_000,
}, async () => {
  const project = makeProject("claude");
  try {
    const result = await invoke(
      [
        "--agent=claude",
        `--state-dir=${project.stateDir}`,
        "--no-trust",
        "--output=json",
        "--timeout=45s",
        "Reply with hello.",
      ],
      project.cwd,
    );
    const document = parse(result, 1);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(document.type, "error");
    assert.equal(document.error?.code, "blocked_prompt");
    assert.equal(document.cleanup.action, "teardown");
  } finally {
    rmSync(project.cwd, { recursive: true, force: true });
  }
});

function parse(result: Invocation, expectedStatus = 0): TerminalDocument {
  if (result.status !== expectedStatus) throw new Error(result.stderr);
  if (result.stdout.includes("\u001b"))
    throw new Error("Structured stdout contains terminal escapes.");
  return JSON.parse(result.stdout) as TerminalDocument;
}

async function invoke(args: readonly string[], cwd: string): Promise<Invocation> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entryPath, ...args], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGINT");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, e2eTimeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (status) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) reject(new Error(`CLI timed out: ${stderr}`));
      else resolve({ status, stdout, stderr });
    });
    child.stdin.end();
  });
}
