import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'

export default defineMcpTool({
  name: 'b24_pst_crm_find_product',
  description: '[NOT IMPLEMENTED] Find an active parent product in Bitrix24 catalog by vendor code or name. If multiple active products match, returns the one with minimum id.',
  inputSchema: {
    vendorCode: z.string().optional().describe('Vendor article/code from supplier document'),
    name: z.string().optional().describe('Product name from supplier document'),
  },
  handler: async ({ vendorCode, name }) => {
    // Both fields are optional in the schema (the toolkit's inputSchema is a
    // raw Zod shape, so a cross-field `.refine()` can't be attached). Guard
    // here instead: a call with neither field set has nothing to search on.
    if (!vendorCode && !name) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: true, message: 'Specify at least one of vendorCode or name to search for a product.' }) }],
      }
    }
    // TODO Week 2: call b24-controller REST API
    throw new Error('b24_pst_crm_find_product is not implemented yet (Week 2)')
  },
})
