/** Keeps public comments out of the credentialed maintainer-review context. */
import { writeFile } from "node:fs/promises";
import { authorPermission } from "./github.mjs";

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
      trusted.push({ author: user.login, body: record.body, state: record.state });
    }
  }
  return trusted;
}

export async function discussion({ github, context, number, path }) {
  const pull_number = Number(number);
  const [pr, comments, reviews] = await Promise.all([
    github.rest.pulls.get({ ...context.repo, pull_number }),
    github.paginate(github.rest.issues.listComments, {
      ...context.repo,
      issue_number: pull_number,
      per_page: 100,
    }),
    github.paginate(github.rest.pulls.listReviews, { ...context.repo, pull_number, per_page: 100 }),
  ]);
  const records = await trustedDiscussion(github, context, [...comments, ...reviews]);
  await writeFile(
    path,
    JSON.stringify({ title: pr.data.title, body: pr.data.body, discussion: records }),
  );
}
