/** Posts complete verdicts or incomplete-review comments against the reviewed commit. */
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
  const { data: submitted } = await github.rest.pulls.createReview({
    ...context.repo,
    pull_number: pr.number,
    commit_id: head,
    event,
    body,
  });
  const dismiss = async () => {
    if (event !== "COMMENT")
      await github.rest.pulls.dismissReview({
        ...context.repo,
        pull_number: pr.number,
        review_id: submitted.id,
        message: "Review superseded: publication could not confirm the current PR and commits.",
      });
  };
  let latest;
  try {
    latest = await currentPr(github, context, pr.number);
  } catch (error) {
    try {
      await dismiss();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Review revalidation failed and the submitted review could not be dismissed",
        { cause: error },
      );
    }
    throw error;
  }
  if (
    !eligible(latest.pr, repository, latest.permission) ||
    latest.pr.head.sha !== head ||
    latest.pr.base.sha !== base
  ) {
    await dismiss();
    core.notice("Review superseded during publication; no actionable verdict remains.");
    return;
  }
  core.info(`Submitted ${event} for ${head}`);
}
