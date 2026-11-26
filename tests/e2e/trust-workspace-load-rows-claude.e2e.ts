/**
 * Claude's workspace load rows and MCP server prompt on the REAL Claude CLI (PRD §5.3, §5.4,
 * C-E2E-29, C-CLAUDE-28, C-CLAUDE-29, C-CLAUDE-30), each in a fresh, untrusted project on Claude
 * 2.1.329 or later. For a folder whose `.mcp.json` declares a server that writes a marker as it
 * starts, `autotrust: true` answers the workspace prompt and then the MCP server prompt, reaches
 * `ready`, and the server starts, while `listClaudeModels` refuses the folder and the server
 * never starts. For a folder whose `.claude/settings.json` only enables a plugin, from a
 * marketplace in the project, whose `SessionStart` hook writes a marker, the probe refuses the
 * plain settings row and the hook never runs, while `autotrust: true` reaches `ready` and the
 * hook runs with no further prompt. For settings that pre-approve a tool permission, the probe
 * refuses the folder and autotrust reaches `ready`. For settings that set an environment
 * variable Claude does not consider safe, the probe rejects the prompt it cannot verify.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { isRecord } from "../../src/core/predicates.ts";
import { type ClaudeSessionApi, startClaude } from "../../src/index.ts";
import { shellQuote } from "../../src/runtime/shell.ts";
import {
  assertProbeRefuses,
  assertStillUntrusted,
  cleanupTimeoutMs,
  markerTimeoutMs,
  preflightTimeoutMs,
  readyTimeoutMs,
  readyWithMarker,
  refusalTestTimeoutMs,
  disclosingSkip as skip,
} from "./claude-workspace-probe.ts";
import { cleanup, type E2eProject, makeProject, waitFor } from "./helpers.ts";

const testTimeoutMs = preflightTimeoutMs + readyTimeoutMs + markerTimeoutMs + cleanupTimeoutMs;

function writeJson(path: string, body: object): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(body));
}

type MarkedProject = { readonly project: E2eProject; readonly marker: string };

/** A project whose `.mcp.json` declares a server that writes `marker` when Claude starts it. */
function mcpProject(): MarkedProject {
  const project = makeProject("claude");
  const marker = join(project.cwd, "mcp-server-started");
  const probe = { command: "touch", args: [marker] };
  writeJson(join(project.cwd, ".mcp.json"), { mcpServers: { probe } });
  return { project, marker };
}

/** A project whose settings only enable a plugin, whose `SessionStart` hook writes `marker`. */
function pluginProject(): MarkedProject {
  const project = makeProject("claude");
  const marker = join(project.cwd, "plugin-hook-ran");
  const marketplace = join(project.cwd, "marketplace");
  const plugin = { name: "elwood-probe", source: "./elwood-probe", description: "probe" };
  writeJson(join(marketplace, ".claude-plugin", "marketplace.json"), {
    name: "elwood-local",
    owner: { name: "elwood" },
    plugins: [plugin],
  });
  const pluginRoot = join(marketplace, "elwood-probe");
  writeJson(join(pluginRoot, ".claude-plugin", "plugin.json"), {
    name: "elwood-probe",
    version: "0.0.1",
    description: "probe",
  });
  const hook = { type: "command", command: `touch ${shellQuote(marker)}` };
  writeJson(join(pluginRoot, "hooks", "hooks.json"), {
    hooks: { SessionStart: [{ hooks: [hook] }] },
  });
  writeJson(join(project.cwd, ".claude", "settings.json"), {
    extraKnownMarketplaces: {
      "elwood-local": { source: { source: "directory", path: marketplace } },
    },
    enabledPlugins: { "elwood-probe@elwood-local": true },
  });
  return { project, marker };
}

/** Starts an autotrust session and returns it with the trust prompts it answers, in order. */
async function autotrusted(project: E2eProject) {
  const session = await startClaude({
    cwd: project.cwd,
    stateDir: project.stateDir,
    autotrust: true,
  });
  const answers: string[] = [];
  session.on("activity", (event) => {
    if (event.kind === "startup_prompt") answers.push(String(event.label));
  });
  return { session, answers };
}

test("C-E2E-29 listClaudeModels refuses a folder whose .mcp.json declares a server", {
  skip,
  timeout: refusalTestTimeoutMs,
}, async () => {
  const { project, marker } = mcpProject();
  await assertProbeRefuses(project, "workspace_mcp_servers", marker);
  await assertStillUntrusted(project, marker, false);
});

test("C-E2E-29 autotrust answers the workspace and MCP server prompts and the server starts", {
  skip,
  // A second marker-length wait covers the MCP server prompt's answer.
  timeout: testTimeoutMs + markerTimeoutMs,
}, async () => {
  const { project, marker } = mcpProject();
  let session: ClaudeSessionApi | undefined;
  try {
    const started = await autotrusted(project);
    session = started.session;
    // Claude shows its MCP server prompt only once the folder is trusted.
    await readyWithMarker(session, marker);
    const both = () => (started.answers.length >= 2 ? true : undefined);
    await waitFor(both, "both prompts answered", markerTimeoutMs);
    assert.deepEqual(started.answers, ["workspace_trust", "mcp_trust"]);
    // "Use this MCP server" approves this server alone; the all-future row would persist
    // `enableAllProjectMcpServers` for every server the folder adds later.
    const local: unknown = JSON.parse(
      readFileSync(join(project.cwd, ".claude", "settings.local.json"), "utf8"),
    );
    assert.ok(isRecord(local), "settings.local.json holds an object");
    assert.deepEqual(local["enabledMcpjsonServers"], ["probe"]);
    assert.equal(local["enableAllProjectMcpServers"], undefined);
    await session.stop();
  } finally {
    await cleanup(session);
  }
});

test("C-E2E-29 listClaudeModels refuses a folder whose settings only enable a plugin", {
  skip,
  timeout: refusalTestTimeoutMs,
}, async () => {
  const { project, marker } = pluginProject();
  await assertProbeRefuses(project, "workspace_settings", marker);
  await assertStillUntrusted(project, marker, false);
});

test("C-E2E-29 trusting a folder whose settings only enable a plugin runs the plugin's hook", {
  skip,
  timeout: testTimeoutMs,
}, async () => {
  const { project, marker } = pluginProject();
  let session: ClaudeSessionApi | undefined;
  try {
    const started = await autotrusted(project);
    session = started.session;
    await readyWithMarker(session, marker);
    assert.deepEqual(started.answers, ["workspace_trust"], "no prompt beyond the workspace's");
    await session.stop();
  } finally {
    await cleanup(session);
  }
});

/** A project whose settings pre-approve a tool permission, and a marker nothing writes. */
function permissionsProject(): MarkedProject {
  const project = makeProject("claude");
  const permissions = { allow: ["Bash(ls:*)"] };
  writeJson(join(project.cwd, ".claude", "settings.json"), { permissions });
  return { project, marker: join(project.cwd, "never-written") };
}

test("C-E2E-29 listClaudeModels refuses a folder whose settings pre-approve a tool permission", {
  skip,
  timeout: refusalTestTimeoutMs,
}, async () => {
  const { project, marker } = permissionsProject();
  await assertProbeRefuses(project, "workspace_settings");
  await assertStillUntrusted(project, marker, false);
});

test("C-E2E-29 autotrust trusts a folder whose settings pre-approve a tool permission", {
  skip,
  timeout: testTimeoutMs,
}, async () => {
  const { project } = permissionsProject();
  let session: ClaudeSessionApi | undefined;
  try {
    const started = await autotrusted(project);
    const live = started.session;
    session = live;
    await waitFor(() => (live.status === "ready" ? true : undefined), "ready", readyTimeoutMs);
    assert.deepEqual(started.answers, ["workspace_trust"]);
    await live.stop();
  } finally {
    await cleanup(session);
  }
});

test("C-E2E-29 listClaudeModels rejects a prompt for settings that set an environment variable", {
  skip,
  timeout: refusalTestTimeoutMs,
}, async () => {
  const project = makeProject("claude");
  const env = { NODE_OPTIONS: "--max-old-space-size=4096" };
  writeJson(join(project.cwd, ".claude", "settings.json"), { env });
  await assertProbeRefuses(project, "workspace_unverified");
});
