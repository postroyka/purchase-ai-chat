import { describe, it, expect, vi } from 'vitest'
import { registerInvoiceBot, BOT_CODE, FEEDBACK_COMMAND } from '../app/utils/register-bot'

// Фейковый AjaxResult (минимальная поверхность, что использует registerInvoiceBot).
const ok = (result: unknown) => ({ isSuccess: true, getErrorMessages: () => [], getData: () => ({ result }) })
const fail = (msgs: string[]) => ({ isSuccess: false, getErrorMessages: () => msgs, getData: () => ({ result: null }) })

function frameStub(makeImpl: (opts: { method: string, params: Record<string, unknown> }) => Promise<unknown>) {
  const make = vi.fn(makeImpl)
  // только actions.v2.call.make — НЕ callMethod (устаревший)
  return { frame: { actions: { v2: { call: { make } } } } as never, make }
}

describe('registerInvoiceBot (#217 — LEGACY imbot.register; портал старый)', () => {
  it('регистрирует бота и команду с верными legacy-методами/параметрами', async () => {
    const { frame, make } = frameStub(async (opts) => {
      if (opts.method === 'imbot.register') return ok(456) // imbot.register → BOT_ID как integer
      if (opts.method === 'imbot.command.register') return ok(99)
      throw new Error(`unexpected ${opts.method}`)
    })
    const r = await registerInvoiceBot(frame, 'https://app.example/b24/bot/event')
    expect(r).toEqual({ botId: 456, commandId: 99 })

    // 1-й вызов: imbot.register — TYPE:'B', EVENT_HANDLER (один URL на все события), PROPERTIES.NAME
    const reg = make.mock.calls[0]![0]
    expect(reg.method).toBe('imbot.register')
    expect(reg.params).toMatchObject({
      CODE: BOT_CODE, TYPE: 'B', EVENT_HANDLER: 'https://app.example/b24/bot/event'
    })
    expect((reg.params.PROPERTIES as { NAME: string }).NAME).toBeTruthy()

    // 2-й вызов: imbot.command.register с BOT_ID из ответа регистрации
    const cmd = make.mock.calls[1]![0]
    expect(cmd.method).toBe('imbot.command.register')
    expect(cmd.params).toMatchObject({
      BOT_ID: 456, COMMAND: FEEDBACK_COMMAND, EVENT_COMMAND_ADD: 'https://app.example/b24/bot/event'
    })
    expect(Array.isArray(cmd.params.LANG)).toBe(true)
  })

  it('работает БЕЗ BX24.callMethod — только через actions.v2.call.make (2 вызова)', async () => {
    const { frame, make } = frameStub(async opts =>
      opts.method === 'imbot.register' ? ok(1) : ok(2))
    await registerInvoiceBot(frame, 'https://app/x')
    expect(make).toHaveBeenCalledTimes(2)
  })

  it('ошибка регистрации бота → бросает; команда не регистрируется', async () => {
    const { frame, make } = frameStub(async () => fail(['CODE_ERROR']))
    await expect(registerInvoiceBot(frame, '')).rejects.toThrow(/imbot\.register: CODE_ERROR/)
    expect(make).toHaveBeenCalledTimes(1) // до команды не дошли
  })

  it('ошибка регистрации команды → бросает', async () => {
    const { frame } = frameStub(async opts =>
      opts.method === 'imbot.register' ? ok(7) : fail(['COMMAND_ERROR']))
    await expect(registerInvoiceBot(frame, 'https://app/x')).rejects.toThrow(/imbot\.command\.register: COMMAND_ERROR/)
  })

  it('успех, но ответ без BOT_ID → бросает, команда не регистрируется', async () => {
    const { frame, make } = frameStub(async () => ok(null)) // isSuccess:true, но result не число
    await expect(registerInvoiceBot(frame, 'https://app/x')).rejects.toThrow(/без BOT_ID/)
    expect(make).toHaveBeenCalledTimes(1)
  })
})
