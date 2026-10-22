/** Private artifacts and committed-file assertions for native question proofs (PRD §12). */
import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function assertUnlinkedRoot(dir: string): void {
  try {
    if (lstatSync(dir).isSymbolicLink())
      throw new Error("Question artifact scan root must not be a symbolic link");
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

function files(dir: string): readonly string[] {
  try {
    assertUnlinkedRoot(dir);
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
    });
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}

/** Sandbox disposal removes this private directory together with its native captures. */
export function privateQuestionArtifacts(root: string) {
  const dir = mkdtempSync(join(root, "question-artifacts-"));
  chmodSync(dir, 0o700);
  let sequence = 0;
  return {
    dir,
    write(label: string, contents: string) {
      if (!/^[a-z-]+$/.test(label)) throw new Error("Invalid question artifact label");
      const path = join(dir, `${++sequence}-${label}.json`);
      const fd = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(fd, contents);
      } finally {
        closeSync(fd);
      }
      return path;
    },
  };
}

/** Ignore unfinished trailing rollout records and links outside the private native home. */
export function committedCodexQuestionRecords(home: string): readonly unknown[] {
  assertUnlinkedRoot(home);
  return files(join(home, "sessions"))
    .filter((path) => path.endsWith(".jsonl"))
    .flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .slice(0, -1)
        .filter(Boolean)
        .map((line): unknown => JSON.parse(line)),
    );
}

/** Answers may appear in native transcripts, never question telemetry or Elwood-owned state. */
export function assertQuestionAnswerPrivacy(
  stateDir: string,
  telemetry: readonly unknown[],
  markers: readonly string[],
): void {
  const payload = JSON.stringify(telemetry);
  const state = files(stateDir).map((path) => readFileSync(path));
  for (const marker of markers) {
    const fragments = new Set([
      marker,
      ...marker.split(/\r\n?|\n/).filter((line) => line.trim().length > 0),
    ]);
    for (const fragment of fragments) {
      for (const needle of new Set([fragment, JSON.stringify(fragment).slice(1, -1)])) {
        if (payload.includes(needle))
          throw new Error("Question telemetry contains submitted answer text");
        if (state.some((contents) => contents.includes(needle)))
          throw new Error("Elwood-owned session state contains submitted answer text");
      }
    }
  }
}
