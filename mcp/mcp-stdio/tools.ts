/**
 * Hand-maintained registry of every MCP tool for the stdio bundle.
 * Adding a new tool: add it under `server/mcp/tools/**` for the HTTP server
 * AND append it here for the stdio bundle. The two registries are checked
 * against each other by tests/unit/mcp-stdio/tools.parity.test.ts.
 */
import deals_findSupplier from '~/server/mcp/tools/deals/find-supplier'
import deals_findContract from '~/server/mcp/tools/deals/find-contract'
import deals_findProduct from '~/server/mcp/tools/deals/find-product'
import deals_createDeal from '~/server/mcp/tools/deals/create-deal'
import meta_submitFeedback from '~/server/mcp/tools/meta/submit-feedback'

export const tools = [
  deals_findSupplier,
  deals_findContract,
  deals_findProduct,
  deals_createDeal,
  meta_submitFeedback,
] as const
