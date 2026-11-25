/** Verify that a Codex trust request names its exact native launch target (PRD §5.5). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createCodexTrustTargetResolver } from "../../src/codex/workspace-trust/target.ts";

const folderFixture = fixture("../fixtures/codex-0.164.0/trust/folder-access.txt");
const backFixture = fixture("../fixtures/codex-0.164.0/trust/folder-access-no-hook-bypass.txt");
const legacyFixture = fixture("../fixtures/codex-0.154.0/directory.txt");
const workspace = "/tmp/elwood-native-CAPTURE";
const legacyWorkspace = "/private/tmp/elwood-native-codex-CAPTURE/project";
const rootNote =
  "Note: You’re in a subdirectory of a Git project. Trusting will apply to the repository root:";
const root = "/tmp/workspace";
const project = join(root, "project");

function fixture(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function folder(...aliases: string[]) {
  return createCodexTrustTargetResolver({
    aliases,
    targets: aliases.map((targetPath) => ({
      target: { targetPath, targetScope: "folder" },
      requiresRepositoryNote: false,
    })),
    isCurrent: () => true,
  });
}

function repository(aliases: readonly string[], repo: string, requiresRepositoryNote = false) {
  return createCodexTrustTargetResolver({
    aliases,
    targets: [{ target: { targetPath: repo, targetScope: "repository" }, requiresRepositoryNote }],
    isCurrent: () => true,
  });
}

function read(
  resolve: ReturnType<typeof createCodexTrustTargetResolver>,
  text: string,
  rowFits: (row: number, inset: number) => boolean = () => true,
) {
  return resolve({ lines: text.split("\n") }, rowFits);
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

test("requires the native decline and footer to come from the same layout", () => {
  const resolve = folder(project);
  for (const fixtureText of [folderFixture, backFixture]) {
    const text = fixtureText.replace(workspace, project);
    expect(read(resolve, text)).toEqual({ targetPath: project, targetScope: "folder" });
    const mismatched = text.replace(/esc (quit|back)/, (_row, choice) =>
      choice === "quit" ? "esc back" : "esc quit",
    );
    expect(read(resolve, mismatched)).toBeUndefined();
  }
});

test("C-CODEX-15 withholds a Codex workspace menu without a selected row", () => {
  const resolve = folder(project);
  for (const [fixtureText, originalPath] of [
    [folderFixture, workspace],
    [backFixture, workspace],
    [legacyFixture, legacyWorkspace],
  ] as const) {
    const text = fixtureText.replace(originalPath, project);
    expect(read(resolve, text)).toEqual({ targetPath: project, targetScope: "folder" });
    expect(read(resolve, text.replace("› 1.", "  1."))).toBeUndefined();
  }
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
  expect(read(resolve, full, (row) => row !== 1)).toBeUndefined();
  expect(read(resolve, full, (row) => row !== 5)).toBeUndefined();
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
  expect(read(resolve, text, (row) => row !== 2)).toEqual({
    targetPath: repo,
    targetScope: "repository",
  });
  expect(read(resolve, text, (row) => row !== 4)).toBeUndefined();
  expect(read(resolve, text, (row) => row !== 5)).toBeUndefined();
  expect(read(resolve, text.replace(cwd, cwd.slice(0, -1)))).toBeUndefined();
});

test("withholds a frame whose path row did not fit", () => {
  const resolve = folder(project);
  const text = legacyFixture.replace(legacyWorkspace, project);
  expect(read(resolve, text, () => false)).toBeUndefined();
  expect(read(resolve, text)).toEqual({ targetPath: project, targetScope: "folder" });
});

test("withholds a matching permitted path when live target verification changes", () => {
  let current = true;
  const resolve = createCodexTrustTargetResolver({
    aliases: [project],
    targets: [
      { target: { targetPath: project, targetScope: "folder" }, requiresRepositoryNote: false },
    ],
    isCurrent: () => current,
  });
  const text = folderFixture.replace(workspace, project);
  expect(read(resolve, text)).toEqual({ targetPath: project, targetScope: "folder" });
  current = false;
  expect(read(resolve, text)).toBeUndefined();
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
  const resolve = createCodexTrustTargetResolver({
    aliases: [project],
    targets,
    isCurrent: () => true,
  });
  expect(read(resolve, folderFixture.replace(workspace, project))).toBeUndefined();
});
