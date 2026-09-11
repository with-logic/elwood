# Recipes

These recipes use Claude explicitly and keep their output and cleanup behavior visible. Start with a project you understand, then adapt the prompts.

## Review a diff into a file

```sh
git diff | elwood --timeout 5m \
  "Review this diff. List correctness issues with file names." > review.txt
```

The answer goes into `review.txt`; diagnostics remain on stderr. Check the exit code before treating the file as a completed review. A failing run can leave partial text.

## JSON output with failure handling

In Bash or Zsh, enable pipeline failure propagation before piping into `jq`:

```sh
set -o pipefail
elwood --output json --timeout 2m \
  "Summarize this repository." \
  | jq -er 'select(.type == "result") | .response'
```

Without `pipefail`, `jq` could succeed after Elwood failed. The `type` check also distinguishes a terminal result from an error document.

For full access to a partial failure, capture stdout separately and preserve Elwood's status:

```sh
result_file=$(mktemp)
trap 'rm -f "$result_file"' EXIT

if elwood --output json --timeout 5m \
  "Explain the release checks." > "$result_file"; then
  jq -er 'select(.type == "result") | .response' < "$result_file"
else
  elwood_status=$?
  jq -r '.error.message' < "$result_file" >&2
  exit "$elwood_status"
fi
```

## Activity in your application

This complete example prints the answer to stdout and tool names to stderr. Save it as `inspect.mts`, install the package locally, then run `node inspect.mts`.

```ts
import { ClaudeSession, ElwoodError } from "@with-logic/elwood";

const session = new ClaudeSession({ cwd: process.cwd() });
try {
  for await (const event of session.stream(
    "Find the build scripts and explain what each one does.",
    { timeoutMs: 120_000 },
  )) {
    if (event.type === "text") process.stdout.write(event.text);
    if (event.type === "tool_call") console.error(`Using ${event.name}`);
  }
} catch (error) {
  if (error instanceof ElwoodError) {
    console.error(`${error.code}: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
} finally {
  await session.close();
}
```

Use `event.type` to choose your UI treatment. Do not render tool output as trusted HTML. The stream is content; add session subscriptions when you also need lifecycle or warning events.

## Warnings before the first turn

```ts
const unsubscribe = session.on("warning", (warning) => {
  console.error(warning.code, warning.message);
});

try {
  console.log(await session.send("Explain the public API."));
} finally {
  unsubscribe();
  await session.close();
}
```

Subscriptions can be registered before startup. The returned function removes that subscription.

## Environment check

```sh
elwood --version
elwood config effective --agent claude
claude --version
```

These are useful first checks in a support report. For launch problems, also try the agent directly in the target workspace. [Troubleshooting](troubleshooting.html) has the next steps.
