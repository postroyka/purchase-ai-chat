# Procure AI — MCP server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Nuxt](https://img.shields.io/badge/Nuxt-4-00DC82?logo=nuxt&logoColor=white)](https://nuxt.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

MCP (Model Context Protocol) server for the **Procure AI** procurement workflow,
built on Nuxt 4 + Nitro with [`@nuxtjs/mcp-toolkit`](https://github.com/nuxt-modules/mcp-toolkit).
It exposes a small set of Bitrix24 CRM tools that an AI agent uses to turn a
supplier document into a procurement deal.

This package lives inside the larger [`purchase-ai-chat`](../) project. The
product source of truth is the root [`docs/PROJECT_BRIEF.md`](../docs/PROJECT_BRIEF.md).

## Tools

All four CRM tools are currently `[NOT IMPLEMENTED]` stubs — they validate their
input and return a stub payload; Week 2 wires them to the b24-controller REST API.

| Tool | Purpose |
|---|---|
| `b24_crm_find_supplier` | Find a supplier (company) in Bitrix24 by UNP (9-digit Belarusian taxpayer number). |
| `b24_crm_find_contract` | Find an active contract for a supplier. |
| `b24_crm_find_product` | Find an active catalog product by vendor code or name (at least one required). |
| `b24_crm_create_deal` | Create a procurement deal (funnel «Закупки», category 1, stage `C1:NEW`, currency BYN). |
| `bx24mcp_submit_feedback` | Meta-tool: file a GitHub issue with the agent's feedback about this MCP. |

## Develop

```bash
pnpm install
pnpm dev          # Nuxt dev server; MCP mounted at /mcp
```

## Build

```bash
pnpm build        # Nuxt/Nitro production build → .output/
pnpm start        # run the built server (node .output/server/index.mjs)
pnpm build:dxt    # build the local stdio (Claude Desktop) bundle → dist/procure-ai-mcp.dxt
```

## Quality gates

```bash
pnpm nuxt prepare
pnpm lint
pnpm test         # vitest (unit + integration)
pnpm build
```

## Transports

The same tool handlers serve two transports:

- **HTTP** — Nuxt route `/mcp` (Streamable HTTP), protected by a Bearer token
  (`NUXT_MCP_AUTH_TOKEN`). Used for the Docker / remote deployment.
- **Stdio (DXT)** — a self-contained bundle for Claude Desktop; see
  [`mcp-stdio/README.md`](./mcp-stdio/README.md).

## Configuration

Runtime config is read from `NUXT_`-prefixed environment variables (see
[`.env.example`](./.env.example)):

| Variable | Purpose |
|---|---|
| `NUXT_BITRIX24_WEBHOOK_URL` | Bitrix24 incoming-webhook URL (per-user secret). |
| `NUXT_MCP_AUTH_TOKEN` | Bearer token guarding the HTTP `/mcp` route. |
| `NUXT_GITHUB_FEEDBACK_TOKEN` | Optional PAT enabling `bx24mcp_submit_feedback`. |
| `NUXT_GITHUB_FEEDBACK_REPO` | Feedback target repo (default `postroyka/purchase-ai-chat`). |
| `NUXT_LOG_LEVEL` | `error` / `warn` / `info` (default) / `debug` / … |

## Docs

- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — layers, transports, hot spots.
- [`docs/SECURITY-AUDIT.md`](./docs/SECURITY-AUDIT.md) — SDK logger redaction audit.
- root [`docs/PROJECT_BRIEF.md`](../docs/PROJECT_BRIEF.md) — product spec.

## License

MIT — see [`LICENSE`](./LICENSE).
