/** Includes only current maintainers and trusted automation in review discussion context. */
import { rm } from "node:fs/promises";
import { authorPermission } from "./github.mjs";
import { boundedContext, recentHistory } from "./history.mjs";
import { publishDiscussion } from "./publish-discussion.mjs";

export async function trustedDiscussion(github, context, records) {
  const permissions = new Map();
  const trusted = [];
  for (const record of records) {
    const user = record.user;
    if (!user?.login) continue;
    const automation =
      user.type === "Bot" && ["github-actions[bot]", "dependabot[bot]"].includes(user.login);
    // Association only avoids lookups for arbitrary public commenters; it never grants access.
    if (!(automation || ["OWNER", "MEMBER", "COLLABORATOR"].includes(record.author_association)))
      continue;
    if (!(automation || permissions.has(user.login))) {
      permissions.set(user.login, await authorPermission(github, context, user));
    }
    if (automation || ["write", "maintain", "admin"].includes(permissions.get(user.login))) {
      trusted.push({
        author: user.login,
        body: record.body,
        state: record.state,
        source: record.source,
        created_at: record.created_at ?? record.submitted_at,
        url: record.html_url,
        reply_to: record.in_reply_to_id,
      });
    }
  }
  return trusted;
}

export async function discussion({ github, context, number, path }) {
  await rm(path, { force: true });
  const pull_number = Number(number);
  const [pr, comments, reviews, inline] = await Promise.all([
    github.rest.pulls.get({ ...context.repo, pull_number }),
    recentHistory(github.rest.issues.listComments, {
      ...context.repo,
      issue_number: pull_number,
      per_page: 100,
    }),
    recentHistory(github.rest.pulls.listReviews, { ...context.repo, pull_number, per_page: 100 }),
    recentHistory(github.rest.pulls.listReviewComments, {
      ...context.repo,
      pull_number,
      per_page: 100,
    }),
  ]);
  const records = await trustedDiscussion(github, context, [
    ...comments.records.map((record) => ({ ...record, source: "comment" })),
    ...reviews.records.map((record) => ({ ...record, source: "review" })),
    ...inline.records.map((record) => ({ ...record, source: "inline" })),
  ]);
  records.sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
  await publishDiscussion(
    path,
    JSON.stringify(
      boundedContext(
        pr.data.title,
        pr.data.body,
        records,
        comments.truncated || reviews.truncated || inline.truncated,
      ),
    ),
  );
}
