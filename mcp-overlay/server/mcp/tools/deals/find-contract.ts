import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'

export default defineMcpTool({
  name: 'b24_pst_crm_find_contract',
  description: '[NOT IMPLEMENTED] Find an active contract for a supplier in Bitrix24. Returns contract id if found.',
  inputSchema: {
    supplierId: z.string().min(1).describe('Bitrix24 company id of the supplier'),
  },
  handler: async (_input) => {
    // TODO Week 2: call b24-controller REST API
    throw new Error('b24_pst_crm_find_contract is not implemented yet (Week 2)')
  },
})
