/** Final request workspace validation. Covers PRD C-CLI-03/C-CLI-04. */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { parseCliArgs } from "../../src/cli/args.ts";
import { finalizeRunRequest, resolveRunSettings } from "../../src/cli/request.ts";
import type { ResolvedRunRequest } from "../../src/cli/types.ts";

type DraftOverrides = Omit<Partial<ResolvedRunRequest>, "cwd"> & {
  readonly cwd?: string | undefined;
};

function draft(root: string, overrides: DraftOverrides = {}): ResolvedRunRequest {
  return {
    agent: "codex",
    output: "text",
    outputExplicit: false,
    trust: true,
    stateDir: root,
    verbose: false,
    stream: false,
    cwd: root,
    imagePaths: [],
    prompt: "go",
    keep: false,
    ephemeral: false,
    sandbox: "workspace-write",
    approvalPolicy: "never",
    ...overrides,
  } as ResolvedRunRequest;
}

describe("final request workspaces", () => {
  test("finalizes new and resumed workspaces and rejects invalid state", async () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-request-finalize-"));
    await expect(finalizeRunRequest(draft(root))).resolves.toMatchObject({ cwd: root, images: [] });
    await expect(finalizeRunRequest(draft(root, { resume: "s", cwd: undefined }))).rejects.toThrow(
      /Stored session/iu,
    );
    await expect(
      finalizeRunRequest(draft(root, { resume: "s", cwd: undefined, explicitAgent: "codex" }), {
        agent: "claude",
        cwd: root,
      }),
    ).rejects.toThrow(/conflicts/iu);
    await expect(
      finalizeRunRequest(draft(root, { resume: "s", cwd: undefined }), {
        agent: "claude",
        cwd: root,
      }),
    ).resolves.toMatchObject({ agent: "claude", cwd: root });
    await expect(finalizeRunRequest(draft(root, { cwd: undefined }))).rejects.toThrow(
      /could not be resolved/iu,
    );
    await expect(finalizeRunRequest(draft(root, { cwd: "relative" }))).rejects.toThrow(
      /absolute/iu,
    );
    const missing = join(root, "missing");
    await expect(finalizeRunRequest(draft(root, { cwd: missing }))).rejects.toThrow(
      `Workspace '${missing}' does not exist.`,
    );
  });

  test("C-CLI-03 resume cannot override its stored workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-request-finalize-"));
    const other = mkdtempSync(join(tmpdir(), "elwood-request-finalize-other-"));
    await expect(
      finalizeRunRequest(draft(root, { resume: "s", cwd: other, cwdExplicit: true }), {
        agent: "codex",
        cwd: root,
      }),
    ).rejects.toThrow(/--cwd cannot be used with --resume/iu);
  });

  test("identifies non-directory and uninspectable workspaces", async () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-request-finalize-"));
    const file = join(root, "file");
    writeFileSync(file, "x");
    await expect(finalizeRunRequest(draft(root, { cwd: file }))).rejects.toThrow(
      `Workspace '${file}' is not a directory.`,
    );
    await expect(finalizeRunRequest(draft(root, { cwd: "/\0" }))).rejects.toThrow(
      "could not be inspected",
    );
  });

  test("requires workspace ownership when POSIX identity is available", async () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-request-finalize-"));
    const spy = vi.spyOn(process, "getuid").mockReturnValue((process.getuid?.() ?? 0) + 1);
    await expect(finalizeRunRequest(draft(root))).rejects.toThrow(/owned/iu);
    spy.mockRestore();
    const absent = vi.spyOn(process, "getuid").mockReturnValue(undefined as never);
    await expect(finalizeRunRequest(draft(root))).resolves.toMatchObject({ cwd: root });
    absent.mockRestore();
  });

  test("validates explicit adapter posture after stored adapter selection", async () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-request-finalize-"));
    await expect(
      finalizeRunRequest(draft(root, { claudeOptionsExplicit: true }), {
        agent: "codex",
        cwd: root,
      }),
    ).rejects.toThrow(/Claude permission/iu);
    await expect(
      finalizeRunRequest(draft(root, { codexOptionsExplicit: true }), {
        agent: "claude",
        cwd: root,
      }),
    ).rejects.toThrow(/Codex launch/iu);
  });

  test("finalizes legacy selected options and default Codex posture", async () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-request-finalize-"));
    const {
      sandbox: _sandbox,
      approvalPolicy: _approval,
      ...withoutPosture
    } = draft(root, {
      model: "gpt",
      reasoningEffort: "high",
    });
    await expect(finalizeRunRequest(withoutPosture as ResolvedRunRequest)).resolves.toMatchObject({
      model: "gpt",
      reasoningEffort: "high",
      sandbox: "workspace-write",
      approvalPolicy: "never",
    });
  });

  test("C-CLI-19 records stored-session and adapter-default provenance", async () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-request-finalize-"));
    const parsed = parseCliArgs(["--resume", "s"]);
    if (parsed.command !== "run") throw new Error("expected run");
    const resolved = resolveRunSettings(parsed, { env: {}, homeDir: root, invocationCwd: root });
    const claude = await finalizeRunRequest(resolved, { agent: "claude", cwd: root });
    expect(claude.resolution?.sources).toMatchObject({
      agent: "stored session s",
      workspace: "stored session s",
      permissionMode: "built-in",
      sandbox: "not applicable",
      approvalPolicy: "not applicable",
    });

    const config = join(root, "config.json");
    writeFileSync(config, JSON.stringify({ schemaVersion: 1, agent: "claude" }), { mode: 0o600 });
    const configured = resolveRunSettings(parsed, {
      env: { ELWOOD_CONFIG: config },
      homeDir: root,
      invocationCwd: root,
    });
    const codex = await finalizeRunRequest(configured, { agent: "codex", cwd: root });
    expect(codex.resolution?.sources).toMatchObject({
      permissionMode: "not applicable",
      sandbox: "built-in",
      approvalPolicy: "built-in",
    });
  });
});
