1. Start Claude Session
     Create a Claude process in a real interactive login-shell PTY, with Elwood hooks/settings applied.

  2. Start Codex Session
     Same as Claude, but for Codex, including Codex-specific config, hooks, transcript observation, and startup prompts.

  3. Resume Claude Session
     Given an Elwood session ID, restore metadata and launch Claude against the saved Claude conversation/session.

  4. Resume Codex Session
     Given an Elwood session ID, restore metadata and launch Codex against the saved Codex conversation/session.

  5. Send Message / Prompt
     Parent app sends a normal user message and Elwood delivers it exactly as a human would through the terminal.

  6. Send Raw Keys
     Parent app sends arbitrary keystrokes/control sequences for low-level terminal control.

  7. Multi-line Prompt Input
     Parent app sends multi-line prompts reliably, using paste/bracketed paste behavior where appropriate.

  8. Observe Terminal Output
     Parent app subscribes to raw PTY output and can render it in xterm.js or another terminal renderer.

  9. Embed Visual Terminal
     Parent app can show the live Claude/Codex terminal, including resize/copy/scroll behavior through its own visual xterm.

  10. Headless Terminal State
     Elwood maintains a headless terminal model for automation, startup prompt detection, and diagnostics.

  11. Resize Session Terminal
     Parent app resizes the session and Elwood updates both the PTY and headless terminal model.

  12. Handle All Claude Hooks
     Every Claude hook event reaches the parent app with strongly typed payloads and response helpers.

  13. Handle All Codex Hooks
     Every Codex hook event reaches the parent app with strongly typed payloads and response helpers.

  14. Fail Open On Hook Problems
     Missing handlers, handler errors, invalid responses, and timeouts fail open while emitting typed error events.

  15. Emit Unified Activity Stream
     Parent app can observe assistant messages, reasoning, tool calls/results, user prompts, status, warnings, hook activity, and errors through one common event stream.

  16. Expose Adapter-Specific Detail
     Unified events are convenient, but Claude/Codex-specific hook and transcript details remain accessible without lossy abstraction.

  17. Detect And Surface Warnings
     Elwood emits structured warnings for things like MCP login failures, version parsing issues, startup automation, or environment problems.

  18. Stop Session Gracefully
     Parent app can ask a session to stop while preserving metadata needed for future resume.

  19. Kill Session Forcefully
     Parent app can immediately terminate a wedged session/process tree.

  20. Teardown Session Completely
     Parent app can remove Elwood-owned metadata, generated settings, sockets, bridge files, and local traces for a session without deleting unrelated Claude/Codex user data.

  21. Deliver A Persona First
     Parent app provides a persona at start and Elwood submits it as the session's first user message once the agent is ready, ahead of any queued messages.

  22. Load User Configuration Additively
     A session started in a project with its own hooks, CLAUDE.md/AGENTS.md, skills, and settings loads all of it exactly as a human terminal session would, alongside Elwood's bridge.

  23. Compact The Conversation
     Parent app calls compact() and Elwood types /compact, then resolves when the adapter's PostCompact hook confirms completion.

  24. List And Switch Models
     Parent app lists the adapter's models with typed current/default markers and switches the session model through the adapter's own picker without ever changing the user's saved default.
