import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'

export default defineMcpTool({
  name: 'b24_crm_find_product',
  description: '[NOT IMPLEMENTED] Find an active parent product in Bitrix24 catalog by vendor code or name. If multiple active products match, returns the one with minimum id.',
  inputSchema: {
    vendorCode: z.string().optional().describe('Vendor article/code from supplier document'),
    name: z.string().optional().describe('Product name from supplier document'),
  },
  handler: async ({ vendorCode, name }) => {
    // TODO Week 2: call b24-controller REST API
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ stub: true, vendorCode, name, message: 'find_product not implemented yet' }) }],
    }
  },
})
