## 7. Claude Tool And Permission Policy

`startClaude` MUST accept options for Claude launch policy, including permission
mode and allowed/disallowed tools. Elwood translates these options to Claude
Code-supported CLI flags or generated settings.

Hook handlers remain the mechanism for dynamic policy. The two approaches are
complementary:

- launch policy narrows Claude's baseline capability;
- hooks observe and control individual lifecycle events and tool calls.

`AskUserQuestion` is explicitly in scope. Elwood must type it and allow a
`PreToolUse` handler to answer it programmatically by returning an allowed
decision with updated input containing answers.
