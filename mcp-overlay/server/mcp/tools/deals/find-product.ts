import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24 } from '~/server/utils/bitrix24'
import { callV2 } from '~/server/utils/sdk-helpers'

interface ProductResult {
  id: number | null
  name?: string
  vendorCode?: string
}

export default defineMcpTool({
  name: 'b24_pst_crm_find_product',
  description:
    'Find an active parent product in the Bitrix24 catalog by vendor code (PURCHASE_ARTICLE). Exact match. If multiple active products match, returns the one with minimum id.',
  inputSchema: {
    vendorCode: z.string().min(1).describe('Vendor article/code from the supplier document — exact match against PURCHASE_ARTICLE field'),
  },
  handler: async ({ vendorCode }) => {
    const b24 = useBitrix24()
    const result = await callV2<ProductResult>(
      b24,
      'shef.purchase.api.procureproduct.findbyvendorcode',
      { vendorCode },
      'Failed to find product by vendor code',
    )

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result ?? { id: null }) }],
    }
  },
})
