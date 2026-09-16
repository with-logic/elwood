/** Exercises optional-context bounds independently of the authoritative review gate. */
import assert from "node:assert/strict";
import test from "node:test";
import { boundedContext, recentHistory } from "../history.mjs";

test("long histories fetch at most discovery plus the three newest pages", async () => {
  const pages = [];
  const result = await recentHistory(({ page }) => {
    pages.push(page);
    return {
      data: [{ page }],
      headers: { link: '<https://api.github.com/resource?page=20>; rel="last"' },
    };
  }, {});
  assert.deepEqual(pages, [1, 18, 19, 20]);
  assert.deepEqual(
    result.records.map((record) => record.page),
    [18, 19, 20],
  );
  assert.equal(result.truncated, true);
});

test("small histories retain every page", async () => {
  const result = await recentHistory(
    ({ page }) => ({
      data: [{ page }],
      headers: { link: '<https://api.github.com/resource?page=2>; rel="last"' },
    }),
    {},
  );
  assert.deepEqual(
    result.records.map((record) => record.page),
    [1, 2],
  );
  assert.equal(result.truncated, false);
});

test("discussion budget retains whole recent Unicode records and marks omissions", () => {
  const records = Array.from({ length: 8 }, (_, index) => ({ index, body: "🙂".repeat(4000) }));
  const result = boundedContext("Title", "Body", records, false);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536);
  assert.equal(result.discussion.at(-1), records.at(-1));
  assert.deepEqual(result.discussion, records.slice(-result.discussion.length));
  const oversized = boundedContext("Title", "x".repeat(70000), [], false);
  assert.equal(oversized.body, null);
  assert.equal(oversized.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) <= 65536);
});
