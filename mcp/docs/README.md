# Documentation

Docs for the Procure AI MCP server. The product source of truth is the root
[`docs/PROJECT_BRIEF.md`](../../docs/PROJECT_BRIEF.md).

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — 15-minute orientation: tools, layers, two transports, hot spots.
- [`SECURITY-AUDIT.md`](./SECURITY-AUDIT.md) — dependency-level audit of the SDK logger surface (enforced by `tests/unit/utils/sdk-logger-leak.test.ts`); re-run on every SDK bump.

See also:

- [`../README.md`](../README.md) — how to run dev / build / test.
- [`../mcp-stdio/README.md`](../mcp-stdio/README.md) — the stdio (DXT) bundle internals and install guides.
