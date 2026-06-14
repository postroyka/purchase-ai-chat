import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24 } from '~/server/utils/bitrix24'
import { callV2 } from '~/server/utils/sdk-helpers'

interface SupplierResult {
  id: number | null
  title?: string
  unp?: string
}

/**
 * Find a Belarusian supplier company by УНП (taxpayer number).
 *
 * Calls the custom controller `shef:purchase.api.procuresupplier.findByUnp`
 * over the standard webhook (callV2). The controller matches the company
 * requisite field `RQ_INN` (exact, country = BY) and returns the minimum-id
 * company when several share one УНП. Russian suppliers (INN+KPP without УНП)
 * are out of scope — see docs/PROJECT_BRIEF.md.
 */
export default defineMcpTool({
  name: 'b24_pst_crm_find_supplier',
  description:
    'Find a supplier (company) in Bitrix24 by UNP (9-digit Belarusian taxpayer number). Returns company id and name if found. Russian suppliers (INN+KPP without UNP) are not searched.',
  inputSchema: {
    // УНП нормализуется (пробелы/дефисы из OCR убираются) ПЕРЕД валидацией —
    // согласовано с PHP-контроллером, который тоже терпит «грязный» ввод (#102).
    // Раньше строгий .length(9) молча отбрасывал «123 456 789» ещё до PHP.
    unp: z.string()
      .transform((s) => s.replace(/[\s-]/g, ''))
      .pipe(z.string().regex(/^\d{9}$/, 'UNP must be 9 digits after stripping spaces/dashes'))
      .describe('UNP — 9-digit Belarusian taxpayer number (spaces/dashes are tolerated and stripped)'),
  },
  handler: async ({ unp }) => {
    const b24 = useBitrix24()
    const result = await callV2<SupplierResult>(
      b24,
      'shef:purchase.api.procuresupplier.findbyunp',
      { unp },
      'Failed to find supplier by UNP',
    )

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result ?? { id: null }) }],
    }
  },
})
