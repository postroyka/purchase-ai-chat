import { basename, resolve, sep } from 'node:path'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24 } from '~/server/utils/bitrix24'
import { callV2 } from '~/server/utils/sdk-helpers'

interface DealResult {
  dealId: number
}

/**
 * Base directory the agent's uploaded files live in. The MCP container mounts
 * the app's `uploads` volume read-only at `/app/uploads` (see
 * docker-compose.prod.yml). `create_deal` receives a `filePath` from the agent
 * and reads the file here to base64-encode it for the deal attachment — so the
 * heavy binary never has to travel through the LLM context window.
 *
 * Overridable via NUXT_UPLOADS_DIR for local dev / tests.
 */
const UPLOADS_DIR = process.env.NUXT_UPLOADS_DIR || '/app/uploads'

/**
 * Resolve `filePath` and assert it stays inside UPLOADS_DIR. The path comes
 * (indirectly) from a document-driven agent, so a crafted value like
 * `../../etc/passwd` must not let the tool read and exfiltrate arbitrary host
 * files into a Bitrix24 deal. Returns the safe absolute path or throws.
 */
function resolveWithinUploads(filePath: string): string {
  const base = resolve(UPLOADS_DIR)
  const abs = resolve(base, filePath)
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error(`filePath escapes the uploads directory: ${JSON.stringify(filePath)}`)
  }
  return abs
}

export default defineMcpTool({
  name: 'b24_pst_crm_create_deal',
  description:
    'Create a procurement deal in Bitrix24 (funnel "Закупки", category 1, stage C1:NEW, currency BYN). Attaches the source file (read by path from the uploads volume) to the deal card and writes the processing log as a comment and timeline entry. Tax 20%, VAT included in price (Y). Unit always "шт". Deal is always created — no duplicate check.',
  inputSchema: {
    supplierId: z.string().min(1).describe('Bitrix24 company id of the supplier'),
    contractId: z.string().optional().describe('Bitrix24 contract id, if found'),
    responsibleUserId: z.string().min(1).describe('Bitrix24 user id to assign the deal to'),
    filePath: z.string().min(1).describe('Absolute path to the source document (FILE_PATH) — must reside inside the uploads directory. The MCP server reads it and base64-encodes it for attachment.'),
    processingLog: z.string().describe('Processing log text — written to deal COMMENTS field and posted as a timeline comment'),
    items: z.array(z.object({
      productId: z.string().optional().describe('Bitrix24 product id if matched'),
      vendorCode: z.string().optional().describe('Vendor article from document'),
      name: z.string().describe('Product name from document'),
      // INTENTIONAL by docs/PROJECT_BRIEF.md (lines 42-43): the document price
      // is per-unit and EXCLUDING VAT, but in Bitrix24 we write it with
      // TAX_RATE=20 and TAX_INCLUDED=Y. This is a deliberate business decision,
      // not a bug — do not "fix" it to exclude VAT during review.
      priceExclVat: z.number().positive().describe('Price per unit excluding VAT, as stated in document'),
      quantity: z.number().positive().describe('Quantity from document'),
    })).min(1).describe('Line items. Unit is always шт regardless of document.'),
  },
  handler: async ({ supplierId, contractId, responsibleUserId, filePath, processingLog, items }) => {
    let fileContent: string
    try {
      const safePath = resolveWithinUploads(filePath)
      const buffer = await readFile(safePath)
      fileContent = buffer.toString('base64')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: true, code: 'file_read_failed', message }) }],
      }
    }

    const b24 = useBitrix24()
    const params: Record<string, unknown> = {
      supplierId,
      responsibleUserId,
      fileName: basename(filePath),
      fileContent,
      processingLog,
      items,
    }
    if (contractId) params.contractId = contractId

    const result = await callV2<DealResult>(
      b24,
      'shef.purchase.api.procuredeal.create',
      params,
      'Failed to create procurement deal',
    )

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result ?? { dealId: null }) }],
    }
  },
})
