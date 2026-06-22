import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeOk, makeFakeBitrix24 } from '../../_helpers/bitrix24-mock'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpTool: <T,>(spec: T) => spec,
}))

const fake = makeFakeBitrix24()
vi.mock('~/server/utils/bitrix24-tenant', () => ({ useBitrix24Tenant: () => fake.b24 }))

const { default: tool } = await import('../../../../server/mcp/tools/deals/find-contract')

describe('b24_pst_crm_find_contract', () => {
  beforeEach(() => { fake.v2Call.mockReset() })

  it('has correct tool name', () => {
    expect((tool as any).name).toBe('b24_pst_crm_find_contract')
  })

  it('calls procurecontract.find with supplierId only', async () => {
    fake.v2Call.mockResolvedValue(fakeOk({ id: 77, number: '2025/12', date: '01.03.2025' }))

    const result = await (tool as any).handler({ supplierId: '42' })
    const payload = JSON.parse(result.content[0].text)

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'shef:purchase.api.procurecontract.find',
      params: { supplierId: '42' },
    })
    expect(payload).toMatchObject({ id: 77, number: '2025/12' })
  })

  it('пробрасывает признак мультиматча из контроллера (#195)', async () => {
    fake.v2Call.mockResolvedValue(fakeOk({ id: 77, number: '2025/12', date: '01.03.2025', multi: true }))
    const result = await (tool as any).handler({ supplierId: '42' })
    expect(JSON.parse(result.content[0].text)).toMatchObject({ id: 77, multi: true })
  })

  it('passes number and date when provided', async () => {
    fake.v2Call.mockResolvedValue(fakeOk({ id: 5 }))

    await (tool as any).handler({ supplierId: '42', number: '2025/12', date: '01.03.2025' })

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'shef:purchase.api.procurecontract.find',
      params: { supplierId: '42', number: '2025/12', date: '01.03.2025' },
    })
  })

  it('omits number and date when not provided', async () => {
    fake.v2Call.mockResolvedValue(fakeOk({ id: null }))

    await (tool as any).handler({ supplierId: '1' })

    const params = (fake.v2Call.mock.calls[0]![0] as any).params
    expect(params).not.toHaveProperty('number')
    expect(params).not.toHaveProperty('date')
  })

  it('returns { id: null } when not found', async () => {
    fake.v2Call.mockResolvedValue(fakeOk(null))

    const result = await (tool as any).handler({ supplierId: '1' })
    expect(JSON.parse(result.content[0].text)).toEqual({ id: null })
  })

  it('propagates a Bitrix24 error response (!isSuccess) as a throw', async () => {
    fake.v2Call.mockResolvedValue({ isSuccess: false, getData: () => ({ result: null }), getErrorMessages: () => ['ERROR_CORE'] })

    await expect((tool as any).handler({ supplierId: '1' })).rejects.toThrow('ERROR_CORE')
  })

  it('propagates a transport failure as a throw', async () => {
    fake.v2Call.mockRejectedValue(new Error('timeout'))

    await expect((tool as any).handler({ supplierId: '1' })).rejects.toThrow()
  })

  it('rejects empty supplierId via Zod schema', () => {
    expect((tool as any).inputSchema.supplierId.safeParse('').success).toBe(false)
  })

  it('rejects contract number longer than 64 chars via Zod schema (#102, symmetric to con:011)', () => {
    expect((tool as any).inputSchema.number.safeParse('A'.repeat(65)).success).toBe(false)
    expect((tool as any).inputSchema.number.safeParse('243Э20').success).toBe(true)
  })
})
