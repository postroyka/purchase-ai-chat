import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24 } from '~/server/utils/bitrix24'
import { callV2 } from '~/server/utils/sdk-helpers'

interface ContractResult {
  id: number | null
  number?: string
  /** Contract date as returned by Bitrix24, formatted d.m.Y (e.g. "15.03.2025"). */
  date?: string
}

/**
 * Find an active procurement contract for a supplier.
 *
 * Calls `shef:purchase.api.procurecontract.find` over the webhook (callV2). The
 * controller queries the "Договора" iblock list (id 32): CLIENT = CO_<id>,
 * ACTIVE=Y, STATUS != Брак, TYPE ∈ {Закупки, Закупки-Комиссионный}, optionally
 * narrowed by NUMBER/DATE, returning the minimum-id match. `number` / `date`
 * are passed only when present. NUMBER matching is homoglyph-tolerant
 * (Latin/Cyrillic look-alikes fold together, e.g. "243Э20"); DATE is exact d.m.Y.
 */
export default defineMcpTool({
  name: 'b24_pst_crm_find_contract',
  description:
    'Find an active procurement contract for a supplier in Bitrix24. Filters by supplier (CLIENT), active status, TYPE in {Закупки, Закупки-Комиссионный}, STATUS != Брак. Optionally narrows by contract number (homoglyph-tolerant Latin/Cyrillic) and date (exact d.m.Y). Returns contract id if found.',
  inputSchema: {
    supplierId: z.string().min(1).describe('Bitrix24 company id of the supplier'),
    number: z.string().max(64).optional().describe('Contract number from the document — pass verbatim (Latin/Cyrillic letters are matched interchangeably server-side, e.g. "243Э20")'),
    date: z.string().max(10).regex(/^\d{2}\.\d{2}\.\d{4}$/).optional().describe('Contract date from the document, format d.m.Y (e.g. "15.03.2025") — exact match'),
  },
  handler: async ({ supplierId, number, date }) => {
    const b24 = useBitrix24()
    const params: Record<string, string> = { supplierId }
    if (number) params.number = number
    if (date) params.date = date

    const result = await callV2<ContractResult>(
      b24,
      'shef:purchase.api.procurecontract.find',
      params,
      'Failed to find contract for supplier',
    )

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result ?? { id: null }) }],
    }
  },
})
