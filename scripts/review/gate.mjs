/** Limits automatic review to current maintainer PRs and four non-converging rounds. */
import { currentPr } from "./github.mjs";
import { eligible, verdict } from "./policy.mjs";

export async function gate({ github, context, core, number }) {
  if (!/^[1-9]\d*$/u.test(String(number))) throw new Error("A positive PR number is required");
  const { pr, permission } = await currentPr(github, context, Number(number));
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  core.setOutput("should", "false");
  if (!eligible(pr, repository, permission)) {
    core.notice(
      "Review skipped: only ready maintainer PRs from this repository into main qualify.",
    );
    return;
  }
  const reviews = await github.paginate(github.rest.pulls.listReviews, {
    ...context.repo,
    pull_number: pr.number,
    per_page: 100,
  });
  const automated = reviews.filter(
    (review) =>
      review.user?.login === "github-actions[bot]" &&
      review.body?.startsWith("<!-- elwood:review -->"),
  );
  if (automated.some((review) => review.state === "APPROVED" && review.commit_id === pr.head.sha)) {
    core.notice("This commit already has an automated approval.");
    return;
  }
  // Pushing a new commit dismisses old approvals; those were converged rounds.
  const nonApproving = automated.filter(
    (review) =>
      review.state !== "APPROVED" &&
      !(review.state === "DISMISSED" && verdict(review.body, true) === "APPROVE"),
  );
  if (nonApproving.length >= 4) {
    core.setFailed(
      "Four automated review rounds without approval; a maintainer must review this PR.",
    );
    return;
  }
  for (const [key, value] of Object.entries({
    should: "true",
    number: pr.number,
    head: pr.head.sha,
    base: pr.base.sha,
  }))
    core.setOutput(key, String(value));
}
