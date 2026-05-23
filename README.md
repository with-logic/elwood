# Elwood

Elwood is a spec-driven TypeScript project. `PRD.md` is the source of truth for
observable behavior; implementation and tests derive from it.

## Development

```sh
bun install
bun run check
```

The full check runs TypeScript, Biome, and Bun tests with 100% line and function
coverage.

## Working Model

- Update `PRD.md` first for behavior that a user, API consumer, or second
  implementation could observe.
- Implement the behavior in `src/`.
- Add or update tests in `tests/`.
- Run `bun run check` before review.
