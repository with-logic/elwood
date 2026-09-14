/** Bare models ignores agent defaults while applying each adapter's own settings (C-CLI-26). */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { main } from "../../src/cli/main.ts";
import type { ResolvedRunRequest } from "../../src/cli/types.ts";
import { modelsHarness } from "./models-fakes.ts";

test("C-CLI-26 environment and saved agent preferences do not narrow the catalogs", async () => {
  const root = mkdtempSync(join(tmpdir(), "elwood-models-settings-"));
  try {
    const config = join(root, "config.json");
    writeFileSync(
      config,
      JSON.stringify({
        schemaVersion: 1,
        agent: "codex",
        claude: { model: "opus", reasoningEffort: "high", permissionMode: "dontAsk" },
        codex: {
          model: "gpt",
          reasoningEffort: "low",
          sandbox: "workspace-write",
          approvalPolicy: "never",
        },
      }),
      { mode: 0o600 },
    );
    const h = modelsHarness();
    const seen: ResolvedRunRequest[] = [];
    const dependencies = {
      ...h.dependencies,
      prepare: (request: ResolvedRunRequest) => {
        seen.push(request);
        return h.dependencies.prepare(request);
      },
    };
    expect(
      await main(
        ["models"],
        {
          ...h.context,
          env: {
            ELWOOD_CONFIG: config,
            ELWOOD_AGENT: "claude",
            ELWOOD_CODEX_SANDBOX: "read-only",
            ELWOOD_CLAUDE_PERMISSION_MODE: "plan",
          },
        },
        dependencies,
      ),
    ).toBe(0);
    expect(seen).toMatchObject([
      { agent: "claude", model: "opus", reasoningEffort: "high", permissionMode: "plan" },
      { agent: "codex", model: "gpt", reasoningEffort: "low", sandbox: "read-only" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("C-CLI-26 adapter posture flags apply only to their matching probes", async () => {
  const h = modelsHarness();
  const seen: ResolvedRunRequest[] = [];
  const dependencies = {
    ...h.dependencies,
    prepare: (request: ResolvedRunRequest) => {
      seen.push(request);
      return h.dependencies.prepare(request);
    },
  };
  expect(
    await main(
      [
        "models",
        "--claude-permission-mode",
        "plan",
        "--codex-sandbox",
        "read-only",
        "--codex-approval-policy",
        "on-request",
      ],
      h.context,
      dependencies,
    ),
  ).toBe(0);
  expect(seen).toMatchObject([
    { agent: "claude", permissionMode: "plan" },
    { agent: "codex", sandbox: "read-only", approvalPolicy: "on-request" },
  ]);
});

test.each([
  "prepare",
  "settings",
])("C-CLI-26 configured JSON is honored for %s failures", async (phase) => {
  const root = mkdtempSync(join(tmpdir(), "elwood-models-json-"));
  try {
    const config = join(root, "config.json");
    writeFileSync(config, JSON.stringify({ schemaVersion: 1, output: "json" }), { mode: 0o600 });
    const h = modelsHarness(phase === "prepare" ? "claude" : undefined);
    expect(
      await main(
        ["models"],
        {
          ...h.context,
          env: {
            ELWOOD_CONFIG: config,
            ...(phase === "settings" ? { ELWOOD_CLAUDE_PERMISSION_MODE: "invalid" } : {}),
          },
        },
        h.dependencies,
      ),
    ).toBe(phase === "settings" ? 2 : 1);
    expect(JSON.parse(h.stdout.value)).toMatchObject({
      type: "models",
      agents: [{ agent: "codex" }],
      errors: [{ agent: "claude" }],
    });
    expect(h.stdout.value.trim().split("\n")).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
