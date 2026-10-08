/** Resolves repository permissions for trusted review discussion; implements PRD §16. */
export async function effectiveUserPermission(github, context, user) {
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
