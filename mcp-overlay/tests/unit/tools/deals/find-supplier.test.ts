import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeOk, makeFakeBitrix24 } from '../../_helpers/bitrix24-mock'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpTool: <T,>(spec: T) => spec,
}))

const fake = makeFakeBitrix24()
vi.mock('~/server/utils/bitrix24', () => ({ useBitrix24: () => fake.b24 }))

const { default: tool } = await import('../../../../server/mcp/tools/deals/find-supplier')

describe('b24_pst_crm_find_supplier', () => {
  beforeEach(() => { fake.v2Call.mockReset() })

  it('has correct tool name', () => {
    expect((tool as any).name).toBe('b24_pst_crm_find_supplier')
  })

  it('calls procuresupplier.findbyunp and returns supplier', async () => {
    fake.v2Call.mockResolvedValue(fakeOk({ id: 42, title: 'ООО Поставщик', unp: '123456789' }))

    const result = await (tool as any).handler({ unp: '123456789' })
    const payload = JSON.parse(result.content[0].text)

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'shef:purchase.api.procuresupplier.findbyunp',
      params: { unp: '123456789' },
    })
    expect(payload).toMatchObject({ id: 42, title: 'ООО Поставщик' })
    expect(fake.v3Call).not.toHaveBeenCalled()
  })

  it('returns { id: null } when controller returns null', async () => {
    fake.v2Call.mockResolvedValue(fakeOk(null))

    const result = await (tool as any).handler({ unp: '000000000' })
    expect(JSON.parse(result.content[0].text)).toEqual({ id: null })
  })

  it('returns { id: null } when controller returns an empty success body', async () => {
    fake.v2Call.mockResolvedValue({ isSuccess: true, getData: () => ({ result: undefined }), getErrorMessages: () => [] })

    const result = await (tool as any).handler({ unp: '123456789' })
    expect(JSON.parse(result.content[0].text)).toEqual({ id: null })
  })

  it('propagates a Bitrix24 error response (!isSuccess) as a throw', async () => {
    fake.v2Call.mockResolvedValue({ isSuccess: false, getData: () => ({ result: null }), getErrorMessages: () => ['ACCESS_DENIED'] })

    await expect((tool as any).handler({ unp: '123456789' })).rejects.toThrow('ACCESS_DENIED')
  })

  it('propagates a transport failure as a throw', async () => {
    fake.v2Call.mockRejectedValue(new Error('network down'))

    await expect((tool as any).handler({ unp: '123456789' })).rejects.toThrow()
  })

  it('rejects UNP shorter than 9 digits via Zod schema', () => {
    expect((tool as any).inputSchema.unp.safeParse('12345').success).toBe(false)
  })

  it('rejects non-digit UNP via Zod schema', () => {
    expect((tool as any).inputSchema.unp.safeParse('12345678a').success).toBe(false)
  })

  it('rejects UNP longer than 9 digits via Zod schema', () => {
    expect((tool as any).inputSchema.unp.safeParse('1234567890').success).toBe(false)
  })

  it('accepts valid 9-digit UNP via Zod schema', () => {
    expect((tool as any).inputSchema.unp.safeParse('123456789').success).toBe(true)
  })

  it('strips spaces/dashes from a "dirty" OCR UNP and normalizes it (#102)', () => {
    const r = (tool as any).inputSchema.unp.safeParse('123 456-789')
    expect(r.success).toBe(true)
    expect(r.data).toBe('123456789')
  })
})
