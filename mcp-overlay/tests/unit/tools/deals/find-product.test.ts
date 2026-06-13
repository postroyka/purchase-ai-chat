import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeOk, makeFakeBitrix24 } from '../../_helpers/bitrix24-mock'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpTool: <T,>(spec: T) => spec,
}))

const fake = makeFakeBitrix24()
vi.mock('~/server/utils/bitrix24', () => ({ useBitrix24: () => fake.b24 }))

const { default: tool } = await import('../../../../server/mcp/tools/deals/find-product')

describe('b24_pst_crm_find_product', () => {
  beforeEach(() => { fake.v2Call.mockReset() })

  it('has correct tool name', () => {
    expect((tool as any).name).toBe('b24_pst_crm_find_product')
  })

  it('calls procureproduct.findbyvendorcode and returns product', async () => {
    fake.v2Call.mockResolvedValue(fakeOk({ id: 15, name: 'Болт М8х20', vendorCode: 'SKU-001' }))

    const result = await (tool as any).handler({ vendorCode: 'SKU-001' })
    const payload = JSON.parse(result.content[0].text)

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'shef:purchase.api.procureproduct.findbyvendorcode',
      params: { vendorCode: 'SKU-001' },
    })
    expect(payload).toMatchObject({ id: 15, name: 'Болт М8х20' })
    expect(fake.v3Call).not.toHaveBeenCalled()
  })

  it('returns { id: null } when controller returns null', async () => {
    fake.v2Call.mockResolvedValue(fakeOk(null))

    const result = await (tool as any).handler({ vendorCode: 'UNKNOWN' })
    expect(JSON.parse(result.content[0].text)).toEqual({ id: null })
  })

  it('propagates a Bitrix24 error response (!isSuccess) as a throw', async () => {
    fake.v2Call.mockResolvedValue({ isSuccess: false, getData: () => ({ result: null }), getErrorMessages: () => ['IBLOCK_NOT_FOUND'] })

    await expect((tool as any).handler({ vendorCode: 'SKU-001' })).rejects.toThrow('IBLOCK_NOT_FOUND')
  })

  it('propagates a transport failure as a throw', async () => {
    fake.v2Call.mockRejectedValue(new Error('socket hang up'))

    await expect((tool as any).handler({ vendorCode: 'SKU-001' })).rejects.toThrow()
  })

  it('rejects empty vendorCode via Zod schema', () => {
    expect((tool as any).inputSchema.vendorCode.safeParse('').success).toBe(false)
  })
})
