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

describe('registerInvoiceBot (#217 — v2 SDK actions.v2.call.make)', () => {
  it('регистрирует бота и команду с верными методами/параметрами', async () => {
    const { frame, make } = frameStub(async (opts) => {
      if (opts.method === 'imbot.v2.Bot.register') return ok({ bot: { id: 456 } })
      if (opts.method === 'imbot.command.register') return ok(99)
      throw new Error(`unexpected ${opts.method}`)
    })
    const r = await registerInvoiceBot(frame, 'https://app.example/b24/bot/event')
    expect(r).toEqual({ botId: 456, commandId: 99 })

    // 1-й вызов: imbot.v2.Bot.register — параметры В fields, type:'bot' (НЕ 'B'), eventMode:'webhook'
    const reg = make.mock.calls[0]![0]
    expect(reg.method).toBe('imbot.v2.Bot.register')
    expect(reg.params.fields).toMatchObject({
      code: BOT_CODE, type: 'bot', eventMode: 'webhook', webhookUrl: 'https://app.example/b24/bot/event'
    })
    expect((reg.params.fields as { properties: { name: string } }).properties.name).toBeTruthy()
    expect((reg.params.fields as Record<string, unknown>).botToken).toBeUndefined() // OAuth — токен не шлём

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
      opts.method === 'imbot.v2.Bot.register' ? ok({ bot: { id: 1 } }) : ok(2))
    await registerInvoiceBot(frame, 'https://app/x')
    expect(make).toHaveBeenCalledTimes(2)
  })

  it('ошибка регистрации бота → бросает; команда не регистрируется', async () => {
    const { frame, make } = frameStub(async () => fail(['BOT_WEBHOOK_URL_REQUIRED']))
    await expect(registerInvoiceBot(frame, '')).rejects.toThrow(/imbot\.v2\.Bot\.register: BOT_WEBHOOK_URL_REQUIRED/)
    expect(make).toHaveBeenCalledTimes(1) // до команды не дошли
  })

  it('ошибка регистрации команды → бросает', async () => {
    const { frame } = frameStub(async opts =>
      opts.method === 'imbot.v2.Bot.register' ? ok({ bot: { id: 7 } }) : fail(['COMMAND_ERROR']))
    await expect(registerInvoiceBot(frame, 'https://app/x')).rejects.toThrow(/imbot\.command\.register: COMMAND_ERROR/)
  })

  it('успех, но ответ без bot.id → бросает, команда не регистрируется', async () => {
    const { frame, make } = frameStub(async () => ok({})) // isSuccess:true, но result без bot
    await expect(registerInvoiceBot(frame, 'https://app/x')).rejects.toThrow(/без bot\.id/)
    expect(make).toHaveBeenCalledTimes(1)
  })
})
