## 15. Open Implementation Notes

- The preferred PTY implementation is still to be selected. The public behavior
  requires a real PTY; the library choice is not part of this PRD.
- The hook bridge should start with Unix domain sockets on macOS unless an
  implementation spike shows a better local-only IPC path.
- A future PRD revision should define the adapter interface for non-Claude tools
  after the Claude adapter proves the core model.
