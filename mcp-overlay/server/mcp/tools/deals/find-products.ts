import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24Tenant } from '~/server/utils/bitrix24-tenant'
import { timedCallV2 } from '~/server/utils/rest-timing'

interface ProductResult {
  id: number | null
  name?: string
  vendorCode?: string
  // #195: true, если по артикулу совпало >1 товара (взят min id) — мультиматч.
  multi?: boolean
}

/**
 * Batch lookup of catalog products by a LIST of vendor codes (#262, рычаг №1).
 *
 * Calls `shef:purchase.api.procureproduct.findByVendorCodes` ONCE over the
 * webhook (one IN-query server-side) instead of N point lookups — замеры (#262)
 * показали, что «медленно» делает число сетевых round-trip'ов, а не вычисление
 * портала. Matching semantics are IDENTICAL to `find_product`: STRICT exact
 * comparison of the article as-is (no homoglyph/layout folding), minimum-id on
 * duplicates with `multi: true`.
 *
 * Returns a LIST aligned to the requested codes; each entry is self-describing
 * (carries its own `vendorCode`), so the agent matches by field, not by index:
 *   - found:     `{ id, name, vendorCode[, multi] }`
 *   - not found: `{ vendorCode, id: null }`
 * (PHP returns a list, not a map, чтобы числовые артикулы вроде "654441" не
 * стали int-ключами — см. b24-controller/lib/controllers/procureproduct.php.)
 */
export default defineMcpTool({
  name: 'b24_pst_crm_find_products',
  description:
    'Batch: find multiple active parent products in the Bitrix24 catalog by their vendor codes (PURCHASE_ARTICLE) in ONE request. Prefer this over calling b24_pst_crm_find_product per item — it is one round-trip for the whole list. Matching is a STRICT exact comparison of each article as-is (no homoglyph/layout folding). Returns a list aligned to the input; each entry carries its own vendorCode, so match by that field. Found: { id, name, vendorCode[, multi] }; not found: { vendorCode, id: null }. If multiple active products match one code, returns the minimum id with multi:true. Max 50 codes per call (split larger lists). If this tool hinders you (ambiguous/wrong match, unexpected response shape, or a missing capability), record it in your result\'s feedback[] (see the system prompt, "Сигналы и обратная связь агента").',
  inputSchema: {
    vendorCodes: z.array(z.string().min(1))
      .min(1)
      .max(50)
      .describe('Vendor article codes from the supplier document — pass each verbatim; matched by STRICT exact comparison server-side (no homoglyph folding). Up to 50 per call; split larger lists into batches.'),
  },
  handler: async ({ vendorCodes }) => {
    const b24 = useBitrix24Tenant()
    const result = await timedCallV2<ProductResult[]>(
      b24,
      'shef:purchase.api.procureproduct.findbyvendorcodes',
      { vendorCodes },
      'Failed to find products by vendor codes',
    )

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result ?? []) }],
    }
  },
})
