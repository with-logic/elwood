/** Verifies optional context never survives a failed fetch or a partial write. */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discussion } from "../discussion.mjs";
import { publishDiscussion } from "../publish-discussion.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "elwood-discussion-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "discussion.txt");
  await writeFile(path, "stale context");
  return { directory, path };
}

test("a failed fetch removes stale optional context", async (t) => {
  const { path } = await fixture(t);
  const failure = new Error("offline");
  const github = {
    rest: {
      pulls: {
        get: () => {
          throw failure;
        },
      },
    },
  };
  await assert.rejects(
    discussion({ github, context: { repo: {} }, number: 10, path }),
    (error) => error === failure,
  );
  await assert.rejects(readFile(path), { code: "ENOENT" });
});

test("a partial write leaves neither a target nor a temporary context file", async (t) => {
  const { directory, path } = await fixture(t);
  const failure = new Error("disk full");
  await assert.rejects(
    publishDiscussion(path, "new context", async (temporary) => {
      await writeFile(temporary, "partial");
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(await readdir(directory), []);
});
