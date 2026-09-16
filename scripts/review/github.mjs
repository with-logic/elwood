/** Fetches current PR permissions; public associations alone never grant review eligibility. */
export async function currentPr(github, context, number) {
  const { owner, repo } = context.repo;
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number });
  return { pr, permission: await authorPermission(github, context, pr.user) };
}

export async function authorPermission(github, context, user) {
  const { owner, repo } = context.repo;
  let permission = "none";
  // Dependabot is GitHub's own dependency updater, not an outside contributor.
  if (user?.login === "dependabot[bot]" && user.type === "Bot") {
    permission = "write";
  } else if (user?.login) {
    try {
      const response = await github.rest.repos.getCollaboratorPermissionLevel({
        owner,
        repo,
        username: user.login,
      });
      permission = response.data.permission;
    } catch (error) {
      if (typeof error !== "object" || error === null || error.status !== 404) throw error;
    }
  }
  return permission;
}
