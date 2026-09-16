/** Exercises the publisher's actual body limit with otherwise valid review evidence. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { post } from "../post.mjs";
import { fixture, report } from "./github-fixture.mjs";
import { reportFixture } from "./report-fixture.mjs";

test("the exact review body limit posts, and the next character fails before submission", async (t) => {
  const prefix = "<!-- elwood:review -->\nReviewed commit: head\n\n";
  const body = `${reportFixture()}\n## Notes\n`;
  for (const length of [65000, 65001]) {
    const f = fixture();
    const reportPath = await report(t);
    await writeFile(reportPath, body + "x".repeat(length - prefix.length - body.length));
    if (length === 65000) {
      await post({ ...f, reportPath });
      assert.equal(f.posted[0].body.length, length);
    } else {
      await assert.rejects(post({ ...f, reportPath }), /body limit/u);
      assert.equal(f.posted.length, 0);
    }
  }
});
