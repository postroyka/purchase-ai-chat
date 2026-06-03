/**
 * Tool-selection eval — does DeepSeek pick the right MCP tool for a given
 * natural-language prompt?
 *
 * Procure AI exposes only five tools: four CRM/deals tools (b24_crm_*) and a
 * meta feedback tool. The cases below are unambiguous prompts where the FIRST
 * tool call should be one specific tool.
 *
 * Skip behaviour: if `DEEPSEEK_API_KEY` is not set, this file logs a notice
 * and exits cleanly — useful so CI can run the eval suite only when the key
 * is configured.
 *
 * To run locally:
 *   export DEEPSEEK_API_KEY=sk-...
 *   pnpm test:evals
 *
 * Note: this file is an `*.eval.ts` and is NOT picked up by `pnpm test`
 * (Vitest is scoped to `*.test.ts`). It is run only by the `evalite` CLI.
 */

import { evalite } from 'evalite'
import { generateText, tool as aiTool, type ToolSet } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'
import { vi } from 'vitest'

// Make the MCP tool default exports importable without bootstrapping Nuxt.
// We only read `name` / `description` / `inputSchema` off each definition —
// the handler is never invoked because the AI SDK `tool()` we register below
// omits `execute`, so `generateText` returns toolCalls without running them.
vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpTool: <T,>(spec: T) => spec,
}))
vi.mock('~/server/utils/github-feedback', () => ({
  consumeFeedbackQuota: () => ({ ok: true, remaining: 5, resetInSeconds: 3600 }),
  createGithubIssue: async () => ({ url: 'https://example/0', number: 0 }),
  formatIssueBody: () => '',
  sanitizeDetails: (s: string) => s,
  sanitizeToolName: (s: string) => s,
  stripHostileChars: (s: string) => s,
  GithubFeedbackError: class extends Error {},
}))

// eslint-disable-next-line import/first
import findSupplier from '~/server/mcp/tools/deals/find-supplier'
// eslint-disable-next-line import/first
import findContract from '~/server/mcp/tools/deals/find-contract'
// eslint-disable-next-line import/first
import findProduct from '~/server/mcp/tools/deals/find-product'
// eslint-disable-next-line import/first
import createDeal from '~/server/mcp/tools/deals/create-deal'
// eslint-disable-next-line import/first
import submitFeedback from '~/server/mcp/tools/meta/submit-feedback'

interface McpToolDef {
  name: string
  description: string
  inputSchema: z.ZodRawShape
}

const ALL_TOOLS: McpToolDef[] = [
  findSupplier as unknown as McpToolDef,
  findContract as unknown as McpToolDef,
  findProduct as unknown as McpToolDef,
  createDeal as unknown as McpToolDef,
  submitFeedback as unknown as McpToolDef,
]

const aiSdkTools = Object.fromEntries(
  ALL_TOOLS.map((t) => [
    t.name,
    aiTool({
      description: t.description,
      inputSchema: z.object(t.inputSchema),
      // `execute` deliberately omitted — generateText returns toolCalls
      // without executing them, which is what we want for selection-only
      // measurement.
    }),
  ]),
) as ToolSet

// @ai-sdk/openai v3 defaults the callable provider to the Responses API
// (`/responses` endpoint), which DeepSeek does not support. Use `.chat()`
// explicitly to force the Chat Completions path (`/chat/completions`).
const deepseekProvider = createOpenAI({
  baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
  // The eval skips when DEEPSEEK_API_KEY is unset (see runner switch below),
  // so an empty key here is fine — generateText is never reached.
  apiKey: process.env.DEEPSEEK_API_KEY ?? '',
})
const deepseek = (modelId: string) => deepseekProvider.chat(modelId)

interface Case {
  input: string
  expected: string
  notes?: string
}

const CASES: Case[] = [
  // ── find_supplier (look a company up by UNP) ───────────────────────────
  {
    input: 'Найди поставщика с УНП 191234567.',
    expected: 'b24_crm_find_supplier',
    notes: '9-digit UNP — straight to find_supplier.',
  },
  {
    input: 'Есть ли в Bitrix24 компания с УНП 100200300?',
    expected: 'b24_crm_find_supplier',
    notes: 'Lookup phrased as a question.',
  },

  // ── find_contract ──────────────────────────────────────────────────────
  {
    input: 'Найди активный договор для поставщика с id 42.',
    expected: 'b24_crm_find_contract',
    notes: 'Contract lookup for a known supplier id.',
  },

  // ── find_product ───────────────────────────────────────────────────────
  {
    input: 'Найди товар по артикулу A-1001 в каталоге.',
    expected: 'b24_crm_find_product',
    notes: 'Vendor-code lookup.',
  },

  // ── create_deal ────────────────────────────────────────────────────────
  {
    input: 'Создай сделку в воронке «Закупки» по поставщику 42, ответственный 5, файл накладной invoice.pdf, позиция: цемент, 100 шт, цена 12.50.',
    expected: 'b24_crm_create_deal',
    notes: 'All required fields present — create the deal.',
  },

  // ── submit_feedback (meta-feedback about the MCP itself) ────────────────
  {
    input: 'Отправь фидбэк разработчикам MCP: описание тула b24_crm_find_product непонятное.',
    expected: 'bx24mcp_submit_feedback',
    notes: 'Meta-feedback about the MCP server — not a CRM action.',
  },
]

if (!process.env.DEEPSEEK_API_KEY) {
  console.warn('[tool-selection.eval] DEEPSEEK_API_KEY not set — skipping eval.')
} else {
  evalite('tool-selection', {
    data: () => CASES.map((c) => ({ input: c.input, expected: c.expected })),
    task: async (input) => {
      const { toolCalls } = await generateText({
        model: deepseek(process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'),
        tools: aiSdkTools,
        prompt: input,
      })
      return toolCalls[0]?.toolName ?? '(no tool call)'
    },
    scorers: [
      {
        name: 'picks-expected-tool',
        scorer: ({ output, expected }) => (output === expected ? 1 : 0),
      },
    ],
  })
}
