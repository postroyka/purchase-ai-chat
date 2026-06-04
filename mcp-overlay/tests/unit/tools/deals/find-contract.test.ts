import { describe, expect, it, vi } from 'vitest'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpTool: <T,>(spec: T) => spec,
}))

const { default: tool } = await import('../../../../server/mcp/tools/deals/find-contract')

describe('b24_pst_crm_find_contract', () => {
  it('has correct tool name', () => {
    expect((tool as any).name).toBe('b24_pst_crm_find_contract')
  })

  it('throws not-implemented error', async () => {
    await expect((tool as any).handler({ supplierId: '42' })).rejects.toThrow(
      'b24_pst_crm_find_contract is not implemented yet',
    )
  })

  it('rejects empty supplierId via Zod schema', () => {
    const schema = (tool as any).inputSchema
    expect(schema.supplierId.safeParse('').success).toBe(false)
  })
})
