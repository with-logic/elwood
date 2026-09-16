/** Reports failed authorized reviews without publishing a verdict; implements PRD §16. */
import { currentPr } from "./github.mjs";
import { eligible } from "./policy.mjs";

export async function reportFailure({ github, context, core, number, head, base, result, runUrl }) {
  const { pr, permission } = await currentPr(github, context, Number(number));
  if (
    !eligible(pr, `${context.repo.owner}/${context.repo.repo}`, permission) ||
    pr.head.sha !== head ||
    pr.base.sha !== base
  ) {
    core.notice("Failure notice skipped: the reviewed PR is no longer current or eligible.");
    return;
  }
  const outcome = result === "cancelled" ? "was canceled" : "did not finish successfully";
  await github.rest.issues.createComment({
    ...context.repo,
    issue_number: pr.number,
    body: `AI review ${outcome}. [See the workflow run](${runUrl}).\n\nRerun with \`/elwood review\`. No approval was granted by this notice.`,
  });
}
