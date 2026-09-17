/** Independent raw-frame trust oracle for native e2e layout drift (C-E2E-09). */

/** Deliberately broader than automation: unknown body/options must still fail the e2e. */
export function trustPromptVisible(frame: string, agent: "claude" | "codex"): boolean {
  const text = frame.replace(/\s+/g, " ");
  if (agent === "codex")
    return /trust the contents of this directory|Hooks need review/i.test(text);
  return /trust this folder|Is this a project you|Accessing workspace:|(?:trust|load) (?:this|the) (?:skill|plugin|MCP server)|New MCP server found|running in Bypass Permissions mode/i.test(
    text,
  );
}

export function folderTrustScreenVisible(frame: string): boolean {
  return /trust this folder|Is this a project you|Accessing workspace:/i.test(
    frame.replace(/\s+/g, " "),
  );
}

/** A fully painted affirmative is evidence even if production option parsing drifts. */
export function completeFolderTrustScreenVisible(frame: string): boolean {
  return (
    folderTrustScreenVisible(frame) && /[❯›].*(?:yes|no)/i.test(frame) && /\byes\b/i.test(frame)
  );
}
