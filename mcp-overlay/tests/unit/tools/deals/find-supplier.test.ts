import { describe, expect, it, vi } from 'vitest'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpTool: <T,>(spec: T) => spec,
}))

const { default: tool } = await import('../../../../server/mcp/tools/deals/find-supplier')

describe('b24_pst_crm_find_supplier', () => {
  it('has correct tool name', () => {
    expect((tool as any).name).toBe('b24_pst_crm_find_supplier')
  })

  it('throws not-implemented error', async () => {
    await expect((tool as any).handler({ unp: '123456789' })).rejects.toThrow(
      'b24_pst_crm_find_supplier is not implemented yet',
    )
  })

  it('rejects UNP shorter than 9 digits via Zod schema', () => {
    const schema = (tool as any).inputSchema
    const result = schema.unp.safeParse('12345')
    expect(result.success).toBe(false)
  })

  it('rejects non-digit UNP via Zod schema', () => {
    const schema = (tool as any).inputSchema
    const result = schema.unp.safeParse('12345678a')
    expect(result.success).toBe(false)
  })

  it('accepts valid 9-digit UNP via Zod schema', () => {
    const schema = (tool as any).inputSchema
    const result = schema.unp.safeParse('123456789')
    expect(result.success).toBe(true)
  })
})
