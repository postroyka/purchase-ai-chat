import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'

export default defineMcpTool({
  name: 'b24_pst_crm_find_supplier',
  description: '[NOT IMPLEMENTED] Find a supplier (company) in Bitrix24 by UNP (9-digit Belarusian taxpayer number). Returns company id and name if found. Russian suppliers (INN+KPP without UNP) are not searched.',
  inputSchema: {
    unp: z.string().length(9).regex(/^\d{9}$/).describe('UNP — 9-digit Belarusian taxpayer number (digits only)'),
  },
  handler: async () => {
    // TODO Week 2: call b24-controller REST API
    throw new Error('b24_pst_crm_find_supplier is not implemented yet (Week 2)')
  },
})
