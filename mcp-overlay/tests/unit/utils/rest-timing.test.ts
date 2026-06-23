import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeOk, makeFakeBitrix24 } from '../_helpers/bitrix24-mock'

// Capture what the timing wrapper logs without a real ConsoleHandler (#262).
// notice() returns a Promise; the mock returns a resolved one so `void`-ed
// callsites don't produce unhandled rejections.
const notice = vi.fn(() => Promise.resolve())
vi.mock('~/server/utils/logger', () => ({ useLogger: () => ({ notice }) }))

const { timedCallV2 } = await import('../../../server/utils/rest-timing')

const fake = makeFakeBitrix24()

describe('timedCallV2 (REST-тайминг, #262)', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
    notice.mockClear()
  })

  it('пробрасывает payload callV2 без изменений', async () => {
    fake.v2Call.mockResolvedValue(fakeOk({ id: 42 }))
    const result = await timedCallV2(fake.b24 as never, 'shef:purchase.api.procuresupplier.findbyunp', { unp: '100007096' }, 'ctx')
    expect(result).toEqual({ id: 42 })
  })

  it('логирует метод (без неймспейса), длительность и ok=true при успехе', async () => {
    fake.v2Call.mockResolvedValue(fakeOk({ id: 1 }))
    await timedCallV2(fake.b24 as never, 'shef:purchase.api.procureproduct.findbyvendorcode', { vendorCode: 'X' }, 'ctx')
    expect(notice).toHaveBeenCalledTimes(1)
    const line = notice.mock.calls[0]![0] as string
    expect(line).toMatch(/^\[rest-timing\] method=procureproduct\.findbyvendorcode ms=\d+ ok=true$/)
  })

  it('логирует ok=false и пробрасывает ошибку при провале REST', async () => {
    fake.v2Call.mockRejectedValue(new Error('boom'))
    await expect(
      timedCallV2(fake.b24 as never, 'shef:purchase.api.procuredeal.create', { supplierId: '1' }, 'ctx'),
    ).rejects.toThrow()
    const line = notice.mock.calls[0]![0] as string
    expect(line).toMatch(/^\[rest-timing\] method=procuredeal\.create ms=\d+ ok=false$/)
  })

  it('НЕ логирует params/секреты (УНП, base64-файл и т.п.) — только метод/ms/ok', async () => {
    fake.v2Call.mockResolvedValue(fakeOk({ dealId: 7 }))
    await timedCallV2(
      fake.b24 as never,
      'shef:purchase.api.procuredeal.create',
      { supplierId: '3639', unp: '100007096', fileContent: 'QkFTRTY0U0VDUkVU', processingLog: 'секрет' },
      'ctx',
    )
    const line = notice.mock.calls[0]![0] as string
    expect(line).not.toContain('100007096')
    expect(line).not.toContain('QkFTRTY0U0VDUkVU')
    expect(line).not.toContain('секрет')
    expect(line).not.toContain('3639')
  })
})
