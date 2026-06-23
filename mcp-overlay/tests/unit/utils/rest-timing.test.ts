import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeBitrix24 } from '../_helpers/bitrix24-mock'

// Capture what the timing wrapper logs without a real ConsoleHandler (#262).
// notice() returns a Promise; the mock returns a resolved one so `void`-ed
// callsites don't produce unhandled rejections.
const notice = vi.fn(() => Promise.resolve())
vi.mock('~/server/utils/logger', () => ({ useLogger: () => ({ notice }) }))

const { timedCallV2 } = await import('../../../server/utils/rest-timing')

const fake = makeFakeBitrix24()

/** AjaxResult-like success carrying `result` + optional server `time.duration` (seconds). */
function okWithTime<T>(result: T, durationSec?: number) {
  return {
    isSuccess: true,
    getData: () => ({ result, ...(durationSec != null ? { time: { duration: durationSec } } : {}) }),
    getErrorMessages: () => [] as string[],
  }
}

/** AjaxResult-like failure (isSuccess=false) carrying error messages. */
function fail(messages: string[]) {
  return {
    isSuccess: false,
    getData: () => undefined,
    getErrorMessages: () => messages,
  }
}

describe('timedCallV2 (REST-тайминг, #262)', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
    notice.mockReset()
  })

  it('пробрасывает payload без изменений', async () => {
    fake.v2Call.mockResolvedValue(okWithTime({ id: 42 }, 0.05))
    const result = await timedCallV2(fake.b24 as never, 'shef:purchase.api.procuresupplier.findbyunp', { unp: '100007096' }, 'ctx')
    expect(result).toEqual({ id: 42 })
  })

  it('логирует метод, wall-ms, серверный srv (duration сек→мс) и ok=true', async () => {
    fake.v2Call.mockResolvedValue(okWithTime({ id: 1 }, 0.052)) // 52 ms server-side
    await timedCallV2(fake.b24 as never, 'shef:purchase.api.procureproduct.findbyvendorcode', { vendorCode: 'X' }, 'ctx')
    expect(notice).toHaveBeenCalledTimes(1)
    const line = notice.mock.calls[0]![0] as string
    expect(line).toMatch(/^\[rest-timing\] method=procureproduct\.findbyvendorcode ms=\d+ srv=52 ok=true$/)
  })

  it('опускает srv, если Bitrix не вернул блок time', async () => {
    fake.v2Call.mockResolvedValue(okWithTime({ id: 1 })) // no time
    await timedCallV2(fake.b24 as never, 'shef:purchase.api.procurecontract.find', { supplierId: '1' }, 'ctx')
    const line = notice.mock.calls[0]![0] as string
    expect(line).toMatch(/^\[rest-timing\] method=procurecontract\.find ms=\d+ ok=true$/)
    expect(line).not.toContain('srv=')
  })

  it('isSuccess=false → ok=false (без srv) + Bitrix24ToolError', async () => {
    fake.v2Call.mockResolvedValue(fail(['boom']))
    await expect(
      timedCallV2(fake.b24 as never, 'shef:purchase.api.procuredeal.create', { supplierId: '1' }, 'ctx'),
    ).rejects.toThrow('boom')
    const line = notice.mock.calls[0]![0] as string
    expect(line).toMatch(/^\[rest-timing\] method=procuredeal\.create ms=\d+ ok=false$/)
  })

  it('транспортная ошибка → ok=false + проброс', async () => {
    fake.v2Call.mockRejectedValue(new Error('network'))
    await expect(
      timedCallV2(fake.b24 as never, 'shef:purchase.api.procureproduct.findbyvendorcode', { vendorCode: 'X' }, 'ctx'),
    ).rejects.toThrow()
    expect(notice.mock.calls[0]![0]).toContain('ok=false')
  })

  it('НЕ логирует params/секреты (УНП, base64-файл и т.п.) — только метод/тайминги/ok', async () => {
    fake.v2Call.mockResolvedValue(okWithTime({ dealId: 7 }, 0.1))
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
