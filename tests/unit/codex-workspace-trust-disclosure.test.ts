/** Classify native Codex disclosure completeness without granting trust (C-ATTN-07). */
import { expect, test, vi } from "vitest";
import {
  hasCompleteWorkspaceDisclosure,
  type RowFits,
} from "../../src/codex/workspace-trust/disclosure.ts";
import { createCodexWorkspaceTrustMatcher } from "../../src/codex/workspace-trust/target.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";

const repoNote =
  "Note: You’re in a subdirectory of a Git project. Trusting will apply to the repository root:";
const folder = "Folder access";
const legacy = "> You are in /project/child";

test.each([
  ["modern folder", "folder access", [folder, "/project"], -1, true],
  ["missing prelude", "folder access", ["/project"], -1, false],
  ["missing path", "folder access", [folder], -1, false],
  ["truncated path", "folder access", [folder, "/project…"], -1, false],
  ["clipped path", "folder access", [folder, "/project"], 1, false],
  ["short modern repo", "folder access", [folder, repoNote, "/project"], -1, true],
  ["full modern repo", "folder access", [folder, "/project/child", repoNote, "/project"], -1, true],
  [
    "clipped modern location",
    "folder access",
    [folder, "/project/child", repoNote, "/project"],
    1,
    false,
  ],
  [
    "truncated modern location",
    "folder access",
    [folder, "/project…", repoNote, "/project"],
    -1,
    false,
  ],
  ["missing modern note", "folder access", [folder, "/project/child", "/project"], -1, false],
  ["legacy folder", "legacy", [legacy], -1, true],
  ["missing legacy path", "legacy", ["> You are in "], -1, false],
  ["clipped legacy path", "legacy", [legacy], 0, false],
  ["missing legacy repo path", "legacy", [legacy, repoNote], -1, false],
  ["inline legacy repo path", "legacy", [legacy, `${repoNote} /project`], -1, true],
  ["relative legacy repo path", "legacy", [legacy, `${repoNote} project`], -1, false],
  ["wrapped legacy repo path", "legacy", [legacy, repoNote, "/project", "with spaces"], -1, true],
  [
    "clipped legacy continuation",
    "legacy",
    [legacy, `${repoNote} /project`, "with spaces"],
    2,
    false,
  ],
] as const)("C-ATTN-07 classifies a %s disclosure", (_name, layout, lines, clippedRow, complete) => {
  const fits = ({ rowIndex }: { rowIndex: number }) => rowIndex !== clippedRow;
  expect(hasCompleteWorkspaceDisclosure(lines, lines.length, layout, fits)).toBe(complete);
});

test.each([
  {
    layout: "folder access",
    lines: [folder, "/project/child", repoNote, "/project"],
    checkedRows: [3, 1],
    inset: 2,
  },
  {
    layout: "legacy",
    lines: [legacy, repoNote, "/project", "with spaces"],
    checkedRows: [0, 2, 3],
    inset: 0,
  },
] as const)("C-ATTN-07 checks $layout disclosure rows at inset $inset", ({
  layout,
  lines,
  checkedRows,
  inset,
}) => {
  const fits = vi.fn<RowFits>(() => true);
  expect(hasCompleteWorkspaceDisclosure(lines, lines.length, layout, fits)).toBe(true);
  expect(fits.mock.calls).toEqual(
    checkedRows.map((rowIndex) => [{ rowIndex, rightInsetCols: inset }]),
  );
});

test("C-ATTN-07 exact launch evidence can match a path containing a literal ellipsis", () => {
  const path = "/project…";
  const lines = capturedFrame("codex-0.164.0/trust/folder-access")
    .replace("/tmp/elwood-native-CAPTURE", path)
    .split("\n");
  const target = { targetPath: path, targetScope: "folder" } as const;
  const match = createCodexWorkspaceTrustMatcher({
    launchDirectoryPaths: [path],
    targets: [{ target, requiresRepositoryNote: false }],
  });
  expect(match({ lines }, () => true)?.target).toEqual(target);
});
