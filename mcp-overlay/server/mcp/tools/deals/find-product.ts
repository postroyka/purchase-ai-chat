import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24Tenant } from '~/server/utils/bitrix24-tenant'
import { callV2 } from '~/server/utils/sdk-helpers'

interface ProductResult {
  id: number | null
  name?: string
  vendorCode?: string
}

/**
 * Find an active parent product in the catalog by vendor code.
 *
 * Calls `shef:purchase.api.procureproduct.findByVendorCode` over the webhook
 * (callV2). The controller matches `PURCHASE_ARTICLE` on active parent products
 * (empty PURCHASE_69_PARENT_PRODUCT) and returns the minimum-id match. Matching
 * is homoglyph-tolerant — Latin/Cyrillic look-alikes match interchangeably
 * (e.g. "тех 100х25х6000"). Matching by name is intentionally NOT supported —
 * vendor code only (B5).
 */
export default defineMcpTool({
  name: 'b24_pst_crm_find_product',
  description:
    'Find an active parent product in the Bitrix24 catalog by vendor code (PURCHASE_ARTICLE). Matching tolerates Latin/Cyrillic look-alike letters. If multiple active products match, returns the one with minimum id.',
  inputSchema: {
    vendorCode: z.string().min(1).describe('Vendor article/code from the supplier document — pass verbatim (Latin/Cyrillic letters are matched interchangeably server-side, e.g. "тех 100х25х6000")'),
  },
  handler: async ({ vendorCode }) => {
    const b24 = useBitrix24Tenant()
    const result = await callV2<ProductResult>(
      b24,
      'shef:purchase.api.procureproduct.findbyvendorcode',
      { vendorCode },
      'Failed to find product by vendor code',
    )

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result ?? { id: null }) }],
    }
  },
})
