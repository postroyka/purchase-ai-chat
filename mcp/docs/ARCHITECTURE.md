# Architecture

15-minute orientation for the Procure AI MCP server. Authoritative product
design lives in the root [`docs/PROJECT_BRIEF.md`](../../docs/PROJECT_BRIEF.md).

## One tool catalogue, two transports

```
            server/mcp/tools/**  (5 defineMcpTool calls)
                  │
       ┌──────────┴──────────────┐
       │                         │
   Nuxt HTTP                  Stdio (DXT)
   /mcp route                 mcp-stdio/server.ts
   Streamable HTTP            StdioServerTransport
   Bearer auth                process-trust
       │                         │
  ┌────┴────┐                    │
  Remote   Local-HTTP        Claude Desktop
  (Docker) (laptop)          spawns process
```

Same handler code, same `useBitrix24()` singleton, same logger redaction. Only
transport + packaging differ.

## Tools

Five tools, all currently `[NOT IMPLEMENTED]` stubs (Week 2 wires them to the
b24-controller REST API):

| Tool | File | Purpose |
|---|---|---|
| `b24_crm_find_supplier` | `server/mcp/tools/deals/find-supplier.ts` | Find a supplier (company) by UNP (9-digit). |
| `b24_crm_find_contract` | `server/mcp/tools/deals/find-contract.ts` | Find an active contract for a supplier. |
| `b24_crm_find_product` | `server/mcp/tools/deals/find-product.ts` | Find an active catalog product by vendor code or name. |
| `b24_crm_create_deal` | `server/mcp/tools/deals/create-deal.ts` | Create a procurement deal (funnel "Закупки"). |
| `bx24mcp_submit_feedback` | `server/mcp/tools/meta/submit-feedback.ts` | File a GitHub issue with agent feedback about this MCP. |

Naming convention (enforced by `tests/unit/mcp-stdio/tool-naming-convention.test.ts`):
Bitrix24 tools are `b24_<domain>(_<entity>)*_<action>`; meta tools are
`bx24mcp_<verb>`.

## Layers

| Layer | File | Notes |
|---|---|---|
| Transport | `@modelcontextprotocol/sdk` (HTTP) / `mcp-stdio/server.ts` (stdio) | toolkit mounts `/mcp`; stdio is bundled separately |
| Auth | `server/middleware/mcp-auth.ts` | Bearer + `timingSafeEqual`. 503 if unset, 401 on mismatch. HTTP only. |
| Tool registry | Nuxt file-glob (HTTP) / `mcp-stdio/tools.ts` (stdio, hand-maintained) | parity enforced by `tests/unit/mcp-stdio/tools.parity.test.ts` |
| Tool handlers | `server/mcp/tools/{deals,meta}/*.ts` | `defineMcpTool` is a no-op passthrough |
| Bitrix24 client | `server/utils/bitrix24.ts` | process-singleton `B24Hook`, logger wrapped in `makeRedactingLogger` |
| REST dispatch | `server/utils/sdk-helpers.ts` | `callV2/callV3/batchV2/batchV3` — only correct path. Direct `actions.*` forbidden. |

## Why these picks

- **Nuxt/Nitro** — `useRuntimeConfig`, file routing, opinionated build; `.output` runs anywhere. Cost: Nuxt-isms leak into tool code → DXT needs shims.
- **`@nuxtjs/mcp-toolkit`** — HTTP transport plumbing for free. `defineMcpTool` is a passthrough we depend on. Cost: barrel pulls Nitro virtuals; bypassed for stdio.
- **zod 4** — required by SDK + b24jssdk. Cost: `sideEffects:false` breaks esbuild lazy init in DXT bundle → one-line preload in `mcp-stdio/nuxt-shims.ts`.
- **DXT shims (not refactor)** — alternative was rewriting every tool file to not use `useRuntimeConfig`. Two small shims won. **Exit criterion:** drop both shims when `@nuxtjs/mcp-toolkit` ships a build that doesn't pull Nitro virtual modules from its `/server` barrel, OR when this project moves off Nuxt entirely.
- **Singleton `B24Hook`** — `RestrictionManager` keeps in-process rate-limit state; two clients would race against Bitrix24's leaky bucket.

## Hot spots (audit on every PR that touches them)

1. **Tool registry parity.** New tool under `server/mcp/tools/**` must also land in `mcp-stdio/tools.ts` — enforced by `tests/unit/mcp-stdio/tools.parity.test.ts`.
2. **Logger redaction.** New HTTP-talking dep with its own logger may bypass `makeRedactingLogger`. Re-run the audit pattern in [`SECURITY-AUDIT.md`](./SECURITY-AUDIT.md) on every SDK bump.
3. **`useRuntimeConfig` callsites.** New callsites break DXT silently — the shim only carries fields it explicitly projects (`mcp-stdio/nuxt-shims.ts`).

## Further reading

- [`SECURITY-AUDIT.md`](./SECURITY-AUDIT.md) — dependency-level audit (SDK logger surface)
- [`../mcp-stdio/README.md`](../mcp-stdio/README.md) — DXT internals
- root [`docs/PROJECT_BRIEF.md`](../../docs/PROJECT_BRIEF.md) — product spec
