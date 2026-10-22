/** Filesystem regressions for private native-question proof evidence (PRD §12). */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  assertQuestionAnswerPrivacy,
  committedCodexQuestionRecords,
  privateQuestionArtifacts,
} from "../e2e/questions/proof-files.ts";

test("Question captures are private, exclusive and removed with their sandbox", () => {
  const root = mkdtempSync(join(tmpdir(), "elwood-question-file-test-"));
  try {
    const artifacts = privateQuestionArtifacts(root);
    assert.equal(statSync(artifacts.dir).mode & 0o777, 0o700);
    const path = artifacts.write("screen", "synthetic answer");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readFileSync(path, "utf8"), "synthetic answer");
    const victim = join(root, "victim");
    writeFileSync(victim, "preserve");
    symlinkSync(victim, join(artifacts.dir, "2-screen.json"));
    assert.throws(() => artifacts.write("screen", "overwrite"));
    assert.equal(readFileSync(victim, "utf8"), "preserve");
    writeFileSync(join(artifacts.dir, "3-screen.json"), "existing");
    assert.throws(() => artifacts.write("screen", "overwrite"));
    assert.equal(readFileSync(join(artifacts.dir, "3-screen.json"), "utf8"), "existing");
    assert.throws(() => artifacts.write("../escape", "invalid"), /Invalid question artifact label/);
    assert.notEqual(privateQuestionArtifacts(root).dir, artifacts.dir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(existsSync(root), false);
});

test("Shared Codex reader accepts only committed JSONL records inside native home", () => {
  const root = mkdtempSync(join(tmpdir(), "elwood-question-record-test-"));
  try {
    assert.deepEqual(committedCodexQuestionRecords(root), []);
    const dir = join(root, "sessions", "nested");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rollout.jsonl"), 'null\n\n{"committed":true}\n{"unfinished":');
    writeFileSync(join(dir, "ignored.txt"), "not JSON");
    const external = join(root, "external.jsonl");
    writeFileSync(external, '{"external":true}\n');
    symlinkSync(external, join(dir, "linked.jsonl"));
    const externalDir = join(root, "external-dir");
    mkdirSync(externalDir);
    writeFileSync(join(externalDir, "rollout.jsonl"), '{"external":true}\n');
    symlinkSync(externalDir, join(dir, "linked-directory"));
    assert.deepEqual(committedCodexQuestionRecords(root), [null, { committed: true }]);
    writeFileSync(join(dir, "invalid.jsonl"), "invalid\n");
    assert.throws(() => committedCodexQuestionRecords(root), SyntaxError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Privacy checks full question activities and every Elwood state file", () => {
  const root = mkdtempSync(join(tmpdir(), "elwood-question-privacy-test-"));
  const marker = "UNIQUE_SUBMITTED_ANSWER\nSECOND\tSYNTHETIC_ANSWER";
  try {
    const state = join(root, "state");
    const nested = join(state, "sessions", "id");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "session.json"), '{"id":"session"}');
    const native = join(root, "native.jsonl");
    writeFileSync(native, marker);
    symlinkSync(native, join(nested, "native-link"));
    assertQuestionAnswerPrivacy(
      state,
      [{ kind: "question", question: { phase: "raised" } }],
      [marker],
    );
    const sidecar = join(nested, "another-sidecar.json");
    for (const value of [marker, ...marker.split("\n")]) {
      assert.throws(
        () => assertQuestionAnswerPrivacy(state, [{ kind: "question", text: value }], [marker]),
        /Question telemetry/,
      );
      for (const contents of [value, JSON.stringify({ answer: value })]) {
        writeFileSync(sidecar, contents);
        assert.throws(() => assertQuestionAnswerPrivacy(state, [], [marker]), /session state/);
      }
      rmSync(sidecar);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const linkedRoot of ["home", "sessions"] as const) {
  test(`Codex record reader rejects a symlinked ${linkedRoot} scan root`, () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-question-root-link-test-"));
    try {
      const externalHome = join(root, "external-home");
      const externalSessions = join(externalHome, "sessions");
      mkdirSync(externalSessions, { recursive: true });
      writeFileSync(join(externalSessions, "rollout.jsonl"), '{"external":true}\n');
      const home = join(root, "home");
      if (linkedRoot === "home") symlinkSync(externalHome, home);
      else {
        mkdirSync(home);
        symlinkSync(externalSessions, join(home, "sessions"));
      }
      assert.throws(
        () => committedCodexQuestionRecords(home),
        /scan root must not be a symbolic link/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("Question scans allow missing roots and propagate ENOTDIR failures", () => {
  const root = mkdtempSync(join(tmpdir(), "elwood-question-scan-error-test-"));
  try {
    const absent = join(root, "absent");
    assert.deepEqual(committedCodexQuestionRecords(absent), []);
    assertQuestionAnswerPrivacy(absent, [], []);
    const file = join(root, "file");
    writeFileSync(file, "not a directory");
    assert.throws(() => committedCodexQuestionRecords(file), { code: "ENOTDIR" });
    assert.throws(() => assertQuestionAnswerPrivacy(file, [], []), { code: "ENOTDIR" });
    assert.throws(() => assertQuestionAnswerPrivacy(join(file, "state"), [], []), {
      code: "ENOTDIR",
    });
    const home = join(root, "home");
    mkdirSync(home);
    writeFileSync(join(home, "sessions"), "not a directory");
    assert.throws(() => committedCodexQuestionRecords(home), { code: "ENOTDIR" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
