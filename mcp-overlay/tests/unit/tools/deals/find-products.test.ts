import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeOk, makeFakeBitrix24 } from '../../_helpers/bitrix24-mock'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpTool: <T,>(spec: T) => spec,
}))

const fake = makeFakeBitrix24()
vi.mock('~/server/utils/bitrix24-tenant', () => ({ useBitrix24Tenant: () => fake.b24 }))

const { default: tool } = await import('../../../../server/mcp/tools/deals/find-products')

describe('b24_pst_crm_find_products (батч, #262)', () => {
  beforeEach(() => { fake.v2Call.mockReset() })

  it('has correct tool name', () => {
    expect((tool as any).name).toBe('b24_pst_crm_find_products')
  })

  it('calls procureproduct.findbyvendorcodes ONE раз со списком артикулов', async () => {
    fake.v2Call.mockResolvedValue(fakeOk([
      { id: 7, name: 'Болт', vendorCode: 'A' },
      { vendorCode: 'B', id: null },
    ]))

    const result = await (tool as any).handler({ vendorCodes: ['A', 'B'] })
    const payload = JSON.parse(result.content[0].text)

    expect(fake.v2Call).toHaveBeenCalledTimes(1)
    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'shef:purchase.api.procureproduct.findbyvendorcodes',
      params: { vendorCodes: ['A', 'B'] },
    })
    expect(payload).toEqual([
      { id: 7, name: 'Болт', vendorCode: 'A' },
      { vendorCode: 'B', id: null },
    ])
    expect(fake.v3Call).not.toHaveBeenCalled()
  })

  it('пробрасывает признак мультиматча из контроллера (#195)', async () => {
    fake.v2Call.mockResolvedValue(fakeOk([{ id: 7, name: 'Болт', vendorCode: 'A', multi: true }]))
    const result = await (tool as any).handler({ vendorCodes: ['A'] })
    expect(JSON.parse(result.content[0].text)).toEqual([{ id: 7, name: 'Болт', vendorCode: 'A', multi: true }])
  })

  it('возвращает [] когда контроллер вернул пусто/undefined', async () => {
    fake.v2Call.mockResolvedValue(fakeOk(undefined))
    const result = await (tool as any).handler({ vendorCodes: ['X'] })
    expect(JSON.parse(result.content[0].text)).toEqual([])
  })

  it('inputSchema: vendorCodes — непустой массив строк, максимум 50', () => {
    const schema = (tool as any).inputSchema.vendorCodes
    expect(schema.safeParse([]).success).toBe(false) // пустой массив
    expect(schema.safeParse(['A', 'B']).success).toBe(true)
    expect(schema.safeParse(Array.from({ length: 51 }, (_, i) => `SKU-${i}`)).success).toBe(false) // >50
    expect(schema.safeParse(Array.from({ length: 50 }, (_, i) => `SKU-${i}`)).success).toBe(true)
  })
})
