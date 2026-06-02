import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'

export default defineMcpTool({
  name: 'find_contract',
  description: 'Find an active contract for a supplier in Bitrix24. Returns contract id if found.',
  inputSchema: {
    supplierId: z.string().describe('Bitrix24 company id of the supplier'),
  },
  handler: async ({ supplierId }) => {
    // TODO Week 2: call b24-controller REST API
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ stub: true, supplierId, message: 'find_contract not implemented yet' }) }],
    }
  },
})
