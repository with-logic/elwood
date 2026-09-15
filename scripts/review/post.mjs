/** Posts a completed review against its exact commit, without merging or bypassing CI. */
import { readFile } from "node:fs/promises";
import { currentPr } from "./github.mjs";
import { eligible, verdict } from "./policy.mjs";

export async function post({ github, context, core, number, head, base, complete, reportPath }) {
  const { pr, permission } = await currentPr(github, context, Number(number));
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  if (!eligible(pr, repository, permission) || pr.head.sha !== head || pr.base.sha !== base) {
    core.notice("Review discarded: the PR, permissions, or reviewed commits changed.");
    return;
  }
  const report = await readFile(reportPath, "utf8");
  if (!report.trim()) throw new Error("No review report was produced");
  const event = verdict(report, complete);
  // GitHub limits review bodies to 65,536 characters. Truncation could hide findings.
  const body = `<!-- elwood:review -->\nReviewed commit: ${head}\n\n${report}`;
  if (body.length > 65_000)
    throw new Error("Review exceeds GitHub's body limit; inspect the artifact");
  await github.rest.pulls.createReview({
    ...context.repo,
    pull_number: pr.number,
    commit_id: head,
    event,
    body,
  });
  core.info(`Submitted ${event} for ${head}`);
}
