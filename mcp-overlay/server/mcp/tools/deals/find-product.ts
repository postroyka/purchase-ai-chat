import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24Tenant } from '~/server/utils/bitrix24-tenant'
import { callV2 } from '~/server/utils/sdk-helpers'

interface ProductResult {
  id: number | null
  name?: string
  vendorCode?: string
  // #195: true, если по артикулу совпало >1 товара (взят min id) — мультиматч.
  multi?: boolean
}

/**
 * Find an active parent product in the catalog by vendor code.
 *
 * Calls `shef:purchase.api.procureproduct.findByVendorCode` over the webhook
 * (callV2). The controller matches `PURCHASE_ARTICLE` on active parent products
 * (empty PURCHASE_69_PARENT_PRODUCT) and returns the minimum-id match. Matching
 * is STRICT exact on the article "as-is" — homoglyph/keyboard-layout folding was
 * deliberately removed (unlike find_contract, where the contract NUMBER is
 * homoglyph-tolerant). Matching by name is intentionally NOT supported —
 * vendor code only (B5).
 */
export default defineMcpTool({
  name: 'b24_pst_crm_find_product',
  description:
    'Find an active parent product in the Bitrix24 catalog by vendor code (PURCHASE_ARTICLE). Matching is a STRICT exact comparison of the article as-is (no homoglyph/layout folding — a near-look-alike article will NOT match). If multiple active products match, returns the one with minimum id. If this tool hinders you (ambiguous/wrong match, unexpected response shape, or a missing capability), record it in your result\'s feedback[] (see the system prompt, "Сигналы и обратная связь агента").',
  inputSchema: {
    vendorCode: z.string().min(1).describe('Vendor article/code from the supplier document — pass verbatim; matched by STRICT exact comparison server-side (no homoglyph folding), e.g. "тех 100х25х6000"'),
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
