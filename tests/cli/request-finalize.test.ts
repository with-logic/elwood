/** Final request workspace validation. Covers PRD C-CLI-03/C-CLI-04. */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { finalizeRunRequest } from "../../src/cli/request.ts";
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
    await expect(finalizeRunRequest(draft(root, { cwd: join(root, "missing") }))).rejects.toThrow(
      /existing directory/iu,
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
});
