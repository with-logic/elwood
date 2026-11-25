/** Verify that a Codex trust request names its exact native launch target (PRD §5.5). */
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import {
  type CodexWorkspaceTrustMatcher,
  createCodexWorkspaceTrustMatcher,
} from "../../src/codex/workspace-trust/target.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";

const folderFixture = capturedFrame("codex-0.164.0/trust/folder-access");
const backFixture = capturedFrame("codex-0.164.0/trust/folder-access-no-hook-bypass");
const legacyFixture = capturedFrame("codex-0.154.0/directory");
const workspace = "/tmp/elwood-native-CAPTURE";
const legacyWorkspace = "/private/tmp/elwood-native-codex-CAPTURE/project";
const rootNote =
  "Note: You’re in a subdirectory of a Git project. Trusting will apply to the repository root:";
const root = "/tmp/workspace";
const project = join(root, "project");
type RowFits = Parameters<CodexWorkspaceTrustMatcher>[1];

function folder(...launchDirectoryPaths: string[]) {
  return createCodexWorkspaceTrustMatcher({
    launchDirectoryPaths,
    targets: launchDirectoryPaths.map((targetPath) => ({
      target: { targetPath, targetScope: "folder" },
      requiresRepositoryNote: false,
    })),
  });
}

function repository(
  launchDirectoryPaths: readonly string[],
  repo: string,
  requiresRepositoryNote = false,
) {
  return createCodexWorkspaceTrustMatcher({
    launchDirectoryPaths,
    targets: [{ target: { targetPath: repo, targetScope: "repository" }, requiresRepositoryNote }],
  });
}

function read(resolve: CodexWorkspaceTrustMatcher, text: string, rowFits: RowFits = () => true) {
  return resolve({ lines: text.split("\n") }, rowFits)?.target;
}

test("preserves meaningful ASCII spaces beside the modern renderer's padding", () => {
  const cwd = join(root, "project ");
  const resolve = folder(cwd);
  const text = folderFixture.replace(workspace, `${cwd}  `);
  expect(read(resolve, text)).toEqual({ targetPath: cwd, targetScope: "folder" });
  expect(read(resolve, text.replace(cwd, join(root, "other")))).toBeUndefined();
});

test("matches launch aliases that still name the checked directory", () => {
  const alias = join(root, "alias");
  const resolve = folder(alias, project);
  expect(read(resolve, folderFixture.replace(workspace, project))).toEqual({
    targetPath: project,
    targetScope: "folder",
  });
  expect(read(resolve, folderFixture.replace(workspace, alias))).toEqual({
    targetPath: alias,
    targetScope: "folder",
  });
});

test("withholds identical padded rows for two distinct path names", () => {
  const cwd = join(root, "project ");
  const alias = cwd.slice(0, -1);
  const resolve = folder(alias, cwd);
  expect(read(resolve, folderFixture.replace(workspace, cwd))).toBeUndefined();
});

test.each([
  ["quit", folderFixture, "esc quit", "esc back"],
  ["back", backFixture, "esc back", "esc quit"],
])("requires the native decline to match the %s footer", (_layout, frame, footer, otherFooter) => {
  const resolve = folder(project);
  const text = frame.replace(workspace, project);
  expect(read(resolve, text)).toEqual({ targetPath: project, targetScope: "folder" });
  expect(read(resolve, text.replace(footer, otherFooter))).toBeUndefined();
});

test.each([
  ["folder access", folderFixture, workspace],
  ["folder access without hook bypass", backFixture, workspace],
  ["legacy", legacyFixture, legacyWorkspace],
])("C-CODEX-15 withholds a %s menu without a selected row", (_layout, frame, path) => {
  const resolve = folder(project);
  const text = frame.replace(path, project);
  expect(read(resolve, text)).toEqual({ targetPath: project, targetScope: "folder" });
  expect(read(resolve, text.replace("› 1.", "  1."))).toBeUndefined();
});

test("reports the exact Git root on short and full modern displays", () => {
  const repo = join(root, "project ");
  const cwd = join(repo, "child");
  const resolve = repository([cwd], repo);
  const expected = { targetPath: repo, targetScope: "repository" };
  const wrappedNote = rootNote.replace("Trusting", "\n  Trusting");
  const disclosure = `  ${wrappedNote}\n  ${repo}   `;
  expect(read(resolve, folderFixture.replace(`  ${workspace}`, disclosure))).toEqual(expected);
  const full = folderFixture.replace(`  ${workspace}`, `  ${cwd}\n\n${disclosure}`);
  expect(read(resolve, full)).toEqual(expected);
  const clippedCwd = vi.fn<RowFits>(({ rowIndex }) => rowIndex !== 1);
  expect(read(resolve, full, clippedCwd)).toBeUndefined();
  expect(clippedCwd).toHaveBeenCalledWith({ rowIndex: 5, rightInsetCols: 2 });
  expect(clippedCwd).toHaveBeenCalledWith({ rowIndex: 1, rightInsetCols: 2 });
  expect(read(resolve, full, ({ rowIndex }) => rowIndex !== 5)).toBeUndefined();
  expect(read(resolve, full.replace(cwd, join(root, "other")))).toBeUndefined();
  expect(read(resolve, folderFixture.replace(workspace, cwd))).toBeUndefined();
  const atRoot = repository([cwd, repo], repo);
  expect(read(atRoot, full)).toEqual(expected);
  expect(read(atRoot, folderFixture.replace(`  ${workspace}`, disclosure))).toEqual(expected);
});

test("corroborates the legacy location and wrapped Git note", () => {
  const repo = join(root, "project with spaces");
  const cwd = join(repo, "child");
  const resolve = repository([cwd], repo);
  const note = rootNote.replace("Trusting", "\n  Trusting");
  const wrappedRepo = repo.replace(" with", "\n  with");
  const text = legacyFixture.replace(legacyWorkspace, `${cwd}\n\n  ${note}\n  ${wrappedRepo}`);
  const fits = vi.fn<RowFits>(({ rowIndex }) => rowIndex !== 2);
  expect(read(resolve, text, fits)).toEqual({ targetPath: repo, targetScope: "repository" });
  expect(fits).toHaveBeenCalledWith({ rowIndex: 0, rightInsetCols: 0 });
  expect(fits).toHaveBeenCalledWith({ rowIndex: 4, rightInsetCols: 0 });
  expect(fits).toHaveBeenCalledWith({ rowIndex: 5, rightInsetCols: 0 });
  expect(read(resolve, text, ({ rowIndex }) => rowIndex !== 4)).toBeUndefined();
  expect(read(resolve, text, ({ rowIndex }) => rowIndex !== 5)).toBeUndefined();
  expect(read(resolve, text.replace(cwd, cwd.slice(0, -1)))).toBeUndefined();
});

test("withholds a frame whose path row did not fit", () => {
  const resolve = folder(project);
  const text = legacyFixture.replace(legacyWorkspace, project);
  expect(read(resolve, text, () => false)).toBeUndefined();
  expect(read(resolve, text)).toEqual({ targetPath: project, targetScope: "folder" });
});

test("requires the repository note when the directory offers two possible native scopes", () => {
  const repo = join(root, "project");
  const cwd = join(repo, "child");
  const resolve = repository([cwd], repo, true);
  expect(read(resolve, folderFixture.replace(workspace, repo))).toBeUndefined();
  expect(read(resolve, legacyFixture.replace(legacyWorkspace, repo))).toBeUndefined();
  const disclosedRoot = folderFixture.replace(workspace, `${rootNote}\n  ${repo}`);
  expect(read(resolve, disclosedRoot)).toEqual({ targetPath: repo, targetScope: "repository" });
  const legacyRoot = legacyFixture.replace(legacyWorkspace, `${cwd}\n  ${rootNote}\n  ${repo}`);
  expect(read(resolve, legacyRoot)).toEqual({ targetPath: repo, targetScope: "repository" });
  const disclosedFolder = folderFixture.replace(workspace, `${rootNote}\n  ${cwd}`);
  expect(read(folder(cwd), disclosedFolder)).toBeUndefined();
});

test("C-TRUST-01 requires current, consistent native workspace chrome", () => {
  const resolve = folder(project);
  const text = folderFixture.replace(workspace, project);
  expect(read(resolve, text.replace("Folder access", ""))).toBeUndefined();
  expect(read(resolve, text.replace("enter continue · esc quit", "unrecognized"))).toBeUndefined();
  expect(read(resolve, text.replace("2. Quit", "3. Quit"))).toBeUndefined();
  const legacy = legacyFixture.replace(legacyWorkspace, project);
  expect(read(resolve, legacy.replace("Press enter to continue", ""))).toBeUndefined();
  expect(read(resolve, legacy.replace("Yes, continue", "Yes"))).toBeUndefined();
  const footer = "  enter continue · esc quit";
  expect(
    read(resolve, text.replace(footer, `  Press enter to continue\n${footer}`)),
  ).toBeUndefined();
  const withoutMenu = text.replace(/ {2}Trust this folder\?[\s\S]*?(?= {2}enter continue)/, "");
  expect(read(resolve, withoutMenu)).toBeUndefined();
});

test("withholds conflicting scopes for the same path", () => {
  const targets = (["folder", "repository"] as const).map((targetScope) => ({
    target: { targetPath: project, targetScope },
    requiresRepositoryNote: false,
  }));
  const resolve = createCodexWorkspaceTrustMatcher({
    launchDirectoryPaths: [project],
    targets,
  });
  expect(read(resolve, folderFixture.replace(workspace, project))).toBeUndefined();
});
