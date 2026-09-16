/** Authorizes one automatic review and explicit maintainer reruns; implements PRD §16. */
import { authorPermission, currentPr } from "./github.mjs";
import { eligible } from "./policy.mjs";

async function requested(github, context) {
  const { eventName, payload } = context;
  if (eventName === "pull_request") return ["opened", "ready_for_review"].includes(payload.action);
  let user;
  if (eventName === "issue_comment") {
    if (
      payload.action !== "created" ||
      !payload.issue?.pull_request ||
      payload.comment?.body !== "/elwood review"
    )
      return false;
    user = payload.comment.user;
  } else if (eventName === "workflow_dispatch") {
    user = payload.sender;
  } else return false;
  // The Dependabot exception applies to PR authors, never command requesters.
  return (
    user?.type === "User" &&
    ["write", "maintain", "admin"].includes(await authorPermission(github, context, user))
  );
}

export async function gate({ github, context, core, number }) {
  if (!/^[1-9]\d*$/u.test(String(number))) throw new Error("A positive PR number is required");
  core.setOutput("should", "false");
  if (!(await requested(github, context))) {
    core.notice("Review skipped: no authorized review request.");
    return;
  }
  const { pr, permission } = await currentPr(github, context, Number(number));
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  if (!eligible(pr, repository, permission)) {
    core.notice(
      "Review skipped: only ready maintainer PRs from this repository into main qualify.",
    );
    return;
  }
  const reviews =
    context.eventName === "pull_request"
      ? await github.paginate(github.rest.pulls.listReviews, {
          ...context.repo,
          pull_number: pr.number,
          per_page: 100,
        })
      : [];
  const automated = reviews.filter(
    (review) =>
      review.user?.login === "github-actions[bot]" &&
      review.body?.startsWith("<!-- elwood:review -->"),
  );
  if (automated.length) {
    core.notice("This PR already received its automatic review. Post /elwood review to run again.");
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
