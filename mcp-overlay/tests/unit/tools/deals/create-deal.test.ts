import { describe, expect, it, vi } from 'vitest'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpTool: <T,>(spec: T) => spec,
}))

const { default: tool } = await import('../../../../server/mcp/tools/deals/create-deal')

const validInput = {
  supplierId: '10',
  responsibleUserId: '1',
  sourceFile: '/uploads/invoice.pdf',
  items: [{ name: 'Болт М8', priceExclVat: 1.5, quantity: 100 }],
}

describe('b24_pst_crm_create_deal', () => {
  it('has correct tool name', () => {
    expect((tool as any).name).toBe('b24_pst_crm_create_deal')
  })

  it('throws not-implemented error', async () => {
    await expect((tool as any).handler(validInput)).rejects.toThrow(
      'b24_pst_crm_create_deal is not implemented yet',
    )
  })

  it('rejects empty items array via Zod schema', () => {
    const schema = (tool as any).inputSchema
    const result = schema.items.safeParse([])
    expect(result.success).toBe(false)
  })

  it('rejects negative priceExclVat via Zod schema', () => {
    const schema = (tool as any).inputSchema
    const result = schema.items.safeParse([{ name: 'test', priceExclVat: -1, quantity: 1 }])
    expect(result.success).toBe(false)
  })

  it('rejects zero quantity via Zod schema', () => {
    const schema = (tool as any).inputSchema
    const result = schema.items.safeParse([{ name: 'test', priceExclVat: 1, quantity: 0 }])
    expect(result.success).toBe(false)
  })

  it('rejects empty supplierId via Zod schema', () => {
    const schema = (tool as any).inputSchema
    expect(schema.supplierId.safeParse('').success).toBe(false)
  })

  it('rejects empty responsibleUserId via Zod schema', () => {
    const schema = (tool as any).inputSchema
    expect(schema.responsibleUserId.safeParse('').success).toBe(false)
  })

  it('rejects empty sourceFile via Zod schema', () => {
    const schema = (tool as any).inputSchema
    expect(schema.sourceFile.safeParse('').success).toBe(false)
  })

  it('rejects empty contractId but accepts a non-empty one via Zod schema', () => {
    const schema = (tool as any).inputSchema
    expect(schema.contractId.safeParse('').success).toBe(false)
    expect(schema.contractId.safeParse('77').success).toBe(true)
  })

  it('accepts contractId being omitted (optional) via Zod schema', () => {
    const schema = (tool as any).inputSchema
    expect(schema.contractId.safeParse(undefined).success).toBe(true)
  })
})
