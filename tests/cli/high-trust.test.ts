/**
 * The agent-neutral `--high-trust` switch: layering, expansion, and provenance.
 * Covers PRD §12A.2/§12A.4 (C-CLI-14, C-CLI-22).
 */

import { describe, expect, test } from "vitest";
import { finalizeRunRequest, resolveRunSettings } from "../../src/cli/request/index.ts";
import { detectClaude as detect, detectCodex } from "./agent-fakes.ts";
import { context, root, run, savedConfig } from "./high-trust-helpers.ts";

describe("--high-trust", () => {
  test("C-CLI-22 the flag expands to the Claude bypass posture with flag provenance", async () => {
    const cwd = root();
    const draft = await resolveRunSettings(
      run(["--agent", "claude", "--high-trust", "go"]),
      context(cwd),
    );
    expect(draft).toMatchObject({ highTrust: true, permissionMode: "bypassPermissions" });
    const request = await finalizeRunRequest(draft);
    expect(request.resolution?.sources).toMatchObject({
      highTrust: "--high-trust",
      permissionMode: "--high-trust",
      sandbox: "not applicable",
      approvalPolicy: "not applicable",
    });
  });

  test("C-CLI-22 the flag expands to the Codex full-access posture", async () => {
    const cwd = root();
    const request = await finalizeRunRequest(
      await resolveRunSettings(run(["--high-trust", "go"]), context(cwd), detectCodex),
    );
    expect(request).toMatchObject({
      agent: "codex",
      highTrust: true,
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    });
    expect(request.resolution?.sources).toMatchObject({
      sandbox: "--high-trust",
      approvalPolicy: "--high-trust",
      permissionMode: "not applicable",
    });
  });

  test("C-CLI-14 the environment variable is a strict boolean with its own provenance", async () => {
    const cwd = root();
    const draft = await resolveRunSettings(
      run(["go"]),
      context(cwd, { ELWOOD_HIGH_TRUST: "true" }),
      detect,
    );
    expect(draft).toMatchObject({ highTrust: true, sandbox: "danger-full-access" });
    expect(draft.resolution?.sources).toMatchObject({
      highTrust: "ELWOOD_HIGH_TRUST",
      sandbox: "ELWOOD_HIGH_TRUST",
      approvalPolicy: "ELWOOD_HIGH_TRUST",
    });
    await expect(
      resolveRunSettings(run(["go"]), context(cwd, { ELWOOD_HIGH_TRUST: "maybe" }), detect),
    ).rejects.toThrow("ELWOOD_HIGH_TRUST must be true or false.");
  });

  test("C-CLI-22 a saved highTrust overrides saved per-agent posture keys", async () => {
    const cwd = root();
    const path = savedConfig(cwd, {
      highTrust: true,
      claude: { permissionMode: "plan" },
      codex: { sandbox: "read-only", approvalPolicy: "on-request" },
    });
    const codex = await resolveRunSettings(
      run(["go"]),
      context(cwd, { ELWOOD_CONFIG: path }),
      detect,
    );
    expect(codex).toMatchObject({ sandbox: "danger-full-access", approvalPolicy: "never" });
    expect(codex.resolution?.sources).toMatchObject({
      highTrust: `${path}#highTrust`,
      sandbox: `${path}#highTrust`,
      approvalPolicy: `${path}#highTrust`,
    });
    const claude = await resolveRunSettings(
      run(["--agent", "claude", "go"]),
      context(cwd, { ELWOOD_CONFIG: path }),
      detectCodex,
    );
    expect(claude).toMatchObject({ permissionMode: "bypassPermissions" });
    expect(claude.resolution?.sources.permissionMode).toBe(`${path}#highTrust`);
  });

  test("C-CLI-22 an explicit per-agent flag beats a SAVED highTrust field by field", async () => {
    const cwd = root();
    const path = savedConfig(cwd, { highTrust: true });
    const draft = await resolveRunSettings(
      run(["--codex-sandbox", "read-only", "go"]),
      context(cwd, { ELWOOD_CONFIG: path }),
      detectCodex,
    );
    expect(draft).toMatchObject({ highTrust: true, sandbox: "read-only", approvalPolicy: "never" });
    expect(draft.resolution?.sources).toMatchObject({
      sandbox: "--codex-sandbox",
      approvalPolicy: `${path}#highTrust`,
    });
  });

  test("C-CLI-14 --no-high-trust reverses an inherited true and --no-defaults ignores it", async () => {
    const cwd = root();
    const path = savedConfig(cwd, { highTrust: true });
    const negated = await resolveRunSettings(
      run(["--no-high-trust", "go"]),
      context(cwd, { ELWOOD_HIGH_TRUST: "true", ELWOOD_CONFIG: path }),
      detectCodex,
    );
    expect(negated).toMatchObject({ highTrust: false, sandbox: "workspace-write" });
    expect(negated.resolution?.sources).toMatchObject({
      highTrust: "--no-high-trust",
      sandbox: "built-in",
    });
    expect(run(["--no-high-trust", "go"]).explicit.has("highTrust")).toBe(true);
    const ignored = await resolveRunSettings(
      run(["--no-defaults", "go"]),
      context(cwd, { ELWOOD_HIGH_TRUST: "true", ELWOOD_CONFIG: path }),
      detectCodex,
    );
    expect(ignored).toMatchObject({ highTrust: false });
    expect(ignored.resolution?.sources.highTrust).toBe("built-in");
  });

  test("C-CLI-14 an explicit posture alongside --no-high-trust is not a conflict", async () => {
    const cwd = root();
    const draft = await resolveRunSettings(
      run(["--agent", "claude", "--no-high-trust", "--claude-permission-mode", "plan", "go"]),
      context(cwd, { ELWOOD_HIGH_TRUST: "true" }),
    );
    expect(draft).toMatchObject({ highTrust: false, permissionMode: "plan" });
  });
});
