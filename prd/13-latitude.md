## 13. Implementation Latitude

The following are implementation choices unless they affect the public behavior
above:

- PTY library or native binding choice.
- IPC transport details, provided it is local-only and session-scoped.
- Exact generated settings file layout.
- Exact event-emitter implementation.
- Whether the package runs on Node.js or another compatible JavaScript runtime, as long as the TypeScript API
  contract is met by supported hosts.
- Internal storage filenames under `.elwood/`.

The documentation site's sprite-load errors identify the failing relative asset
path, bounded to 200 characters, and retain the underlying error as their cause.
