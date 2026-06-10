import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24 } from '~/server/utils/bitrix24'
import { callV2 } from '~/server/utils/sdk-helpers'

interface SupplierResult {
  id: number | null
  title?: string
  unp?: string
}

export default defineMcpTool({
  name: 'b24_pst_crm_find_supplier',
  description:
    'Find a supplier (company) in Bitrix24 by UNP (9-digit Belarusian taxpayer number). Returns company id and name if found. Russian suppliers (INN+KPP without UNP) are not searched.',
  inputSchema: {
    unp: z.string().length(9).regex(/^\d{9}$/).describe('UNP — 9-digit Belarusian taxpayer number (digits only)'),
  },
  handler: async ({ unp }) => {
    const b24 = useBitrix24()
    const result = await callV2<SupplierResult>(
      b24,
      'shef.purchase.api.procuresupplier.findbyunp',
      { unp },
      'Failed to find supplier by UNP',
    )

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result ?? { id: null }) }],
    }
  },
})
