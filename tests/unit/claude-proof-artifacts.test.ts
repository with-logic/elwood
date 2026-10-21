/** Private successful and failed native-proof artifacts are observable offline (PRD §12). */
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { ClaudeSessionApi } from "../../src/index.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";
import { claudeQuestionArtifacts } from "../e2e/questions/claude-artifacts.ts";
import { noteLastLine } from "../e2e/questions/claude-cases.ts";

test("real rendered stages and failure snapshots are saved privately", async () => {
  const root = mkdtempSync(join(tmpdir(), "elwood-claude-artifact-success-"));
  const terminal = createHeadlessTerminal({ cols: 80, rows: 8 }, () => undefined);
  const session: Pick<ClaudeSessionApi, "terminal" | "status"> = { terminal, status: "ready" };
  const diagnostic = vi.fn();
  const artifacts = claudeQuestionArtifacts(() => session, root, diagnostic);
  try {
    for (const text of ["Review your answers", "❯ Submit", noteLastLine]) {
      await terminal.writeOutput(`\x1b[2J\x1b[H${text}`);
      artifacts.observe();
    }
    artifacts.failure(["synthetic write"], []);
    artifacts.save();
    const dir = join(root, readdirSync(root)[0]!);
    const files = readdirSync(dir);
    expect(files).toEqual(["1-failure-screen.json", "2-failure.json", "3-stages.json"]);
    expect(readFileSync(join(dir, files[0]!), "utf8")).toContain(noteLastLine);
    const failure: unknown = JSON.parse(readFileSync(join(dir, files[1]!), "utf8"));
    expect(failure).toMatchObject({ writes: ["synthetic write"], status: "ready", events: [] });
    const stages: unknown = JSON.parse(readFileSync(join(dir, files[2]!), "utf8"));
    expect(stages).toMatchObject({
      review: { text: expect.stringContaining("Review your answers") },
      submit: { text: expect.stringContaining("❯ Submit") },
      text: { text: expect.stringContaining(noteLastLine) },
    });
    expect(diagnostic).not.toHaveBeenCalled();
  } finally {
    terminal.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact write and even diagnostic failures remain best-effort", () => {
  const root = mkdtempSync(join(tmpdir(), "elwood-claude-artifact-proof-"));
  const diagnostic = vi.fn();
  const artifacts = claudeQuestionArtifacts(() => undefined, root, diagnostic);
  rmSync(root, { recursive: true, force: true });
  expect(() => artifacts.save()).not.toThrow();
  expect(diagnostic).toHaveBeenCalledOnce();
  expect(() =>
    claudeQuestionArtifacts(
      () => undefined,
      root,
      () => {
        throw new Error("diagnostic");
      },
    ),
  ).not.toThrow();
});

