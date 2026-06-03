import { describe, expect, it, vi } from 'vitest'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpTool: <T,>(spec: T) => spec,
}))

const { default: tool } = await import('../../../../server/mcp/tools/deals/find-product')

describe('b24_pst_crm_find_product', () => {
  it('has correct tool name', () => {
    expect((tool as any).name).toBe('b24_pst_crm_find_product')
  })

  it('returns error when neither vendorCode nor name is provided', async () => {
    const result = await (tool as any).handler({})
    const body = JSON.parse(result.content[0].text)
    expect(body.error).toBe(true)
    expect(body.message).toMatch(/vendorCode or name/)
  })

  it('throws not-implemented when vendorCode is provided', async () => {
    await expect((tool as any).handler({ vendorCode: 'SKU-001' })).rejects.toThrow(
      'b24_pst_crm_find_product is not implemented yet',
    )
  })

  it('throws not-implemented when name is provided', async () => {
    await expect((tool as any).handler({ name: 'Болт М8' })).rejects.toThrow(
      'b24_pst_crm_find_product is not implemented yet',
    )
  })

  it('throws not-implemented when both fields are provided', async () => {
    await expect((tool as any).handler({ vendorCode: 'SKU-001', name: 'Болт М8' })).rejects.toThrow(
      'b24_pst_crm_find_product is not implemented yet',
    )
  })
})
