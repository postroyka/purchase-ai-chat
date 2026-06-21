import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { useInstall, STANDALONE_HINT_MS } from '../app/composables/useInstall'
import { ENSURE_SCHEMA_METHOD } from '../app/utils/ensure-schema'

// useInstall полагается на авто-импорты Nuxt (ref/watch/onMounted/onUnmounted/useB24). Стабим
// их как глобалы (как в useMetrics.test.ts), без поднятия Nuxt. `watch` и `onMounted` — стабы,
// захватывающие колбэк: это позволяет дёргать его вручную и контролировать момент срабатывания.
let watchCb: (() => unknown) | undefined
let mountedCb: (() => void) | undefined

const b24 = {
  isInit: vi.fn<() => boolean>(),
  get: vi.fn()
}

beforeEach(() => {
  watchCb = undefined
  mountedCb = undefined
  b24.isInit.mockReset()
  b24.get.mockReset()
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('watch', (_src: unknown, cb: () => unknown, opts?: { immediate?: boolean }) => {
    watchCb = cb
    if (opts?.immediate) cb()
  })
  vi.stubGlobal('onMounted', (cb: () => void) => {
    mountedCb = cb
  })
  vi.stubGlobal('onUnmounted', () => {})
  vi.stubGlobal('useB24', () => b24)
})

/** Прогнать микрозадачи, чтобы доехали await'ы внутри finishInstall (бот → команда → ensureSchema
 *  → installFinish — несколько последовательных await, поэтому крутим с запасом). */
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

// Фейковый AjaxResult для actions.v2.call.make (регистрация бота #217 + ensureSchema #176).
const okResult = (result: unknown) => ({ isSuccess: true, getErrorMessages: () => [], getData: () => ({ result }) })
// Валидный отчёт ensureSchema по умолчанию (поля созданы/на месте, ничего не упало).
const schemaOk = { ok: true, created: ['UF_CRM_DEAL_SH_PRCHS_AI_FILE'], existing: ['UF_CRM_DEAL_DOGOVOR'], failed: [] }

// `make` отвечает по методу: register → bot.id, ensureSchema → отчёт, остальное (command) → id.
function defaultMake() {
  return vi.fn(async (opts: { method: string }) => {
    if (opts.method === 'imbot.v2.Bot.register') return okResult({ bot: { id: 1 } })
    if (opts.method === ENSURE_SCHEMA_METHOD) return okResult(schemaOk)
    return okResult(2)
  })
}

function frameStub(over: Partial<{ isInstallMode: boolean, installFinish: () => Promise<unknown>, botMake: ReturnType<typeof vi.fn> }> = {}) {
  const make = over.botMake ?? defaultMake()
  return {
    isInstallMode: true,
    installFinish: vi.fn().mockResolvedValue(undefined),
    actions: { v2: { call: { make } } }, // v2-экшен SDK (НЕ устаревший BX24.callMethod)
    ...over
  }
}

describe('useInstall — подтверждение установки приложения Битрикс24', () => {
  it('install-режим: вызывает installFinish ровно раз и ставит state=done', async () => {
    const frame = frameStub({ isInstallMode: true })
    b24.isInit.mockReturnValue(true)
    b24.get.mockReturnValue(frame)

    const { state } = useInstall() // immediate-watch → finishInstall
    await flush()

    expect(frame.installFinish).toHaveBeenCalledTimes(1)
    expect(state.value).toBe('done')
  })

  it('install-режим: бот + ensureSchema через actions.v2.call.make СТРОГО ДО installFinish (#217/#176)', async () => {
    // Лог порядка: make и installFinish пишут в него — донастройка (бот + схема) обязана быть до
    // finish, иначе перезагрузка фрейма после installFinish оборвала бы REST-вызовы.
    const order: string[] = []
    const botMake = vi.fn(async (opts: { method: string }) => {
      order.push(`make:${opts.method}`)
      if (opts.method === 'imbot.v2.Bot.register') return okResult({ bot: { id: 1 } })
      if (opts.method === ENSURE_SCHEMA_METHOD) return okResult(schemaOk)
      return okResult(2)
    })
    const installFinish = vi.fn(async () => {
      order.push('installFinish')
    })
    const frame = frameStub({ isInstallMode: true, botMake, installFinish })
    b24.isInit.mockReturnValue(true)
    b24.get.mockReturnValue(frame)

    const { state, schemaStatus } = useInstall()
    await flush()

    expect(order).toEqual([
      'make:imbot.v2.Bot.register',
      'make:imbot.command.register',
      `make:${ENSURE_SCHEMA_METHOD}`,
      'installFinish'
    ])
    expect(frame.installFinish).toHaveBeenCalledTimes(1)
    expect(state.value).toBe('done')
    expect(schemaStatus.value).toBe('ok')
  })

  it('сбой регистрации (resolved isSuccess:false) — best-effort: installFinish зовётся, botWarning, state=done', async () => {
    const botMake = vi.fn().mockResolvedValue({ isSuccess: false, getErrorMessages: () => ['NO_SCOPE'], getData: () => ({ result: null }) })
    const frame = frameStub({ isInstallMode: true, botMake })
    b24.isInit.mockReturnValue(true)
    b24.get.mockReturnValue(frame)

    const { state, botWarning } = useInstall()
    await flush()

    expect(botMake).toHaveBeenCalled()
    expect(frame.installFinish).toHaveBeenCalledTimes(1) // установка всё равно завершена
    expect(state.value).toBe('done')
    expect(botWarning.value).toBeTruthy() // не-фатальная подсказка выставлена
  })

  it('сбой регистрации (raw reject от SDK) — тоже best-effort: installFinish зовётся, state=done', async () => {
    const botMake = vi.fn().mockRejectedValue(new Error('network')) // именно throw, не resolved-false
    const frame = frameStub({ isInstallMode: true, botMake })
    b24.isInit.mockReturnValue(true)
    b24.get.mockReturnValue(frame)

    const { state, botWarning } = useInstall()
    await flush()

    expect(frame.installFinish).toHaveBeenCalledTimes(1)
    expect(state.value).toBe('done')
    expect(botWarning.value).toBeTruthy()
  })

  it('ensureSchema вернул failed-поля → schemaStatus=partial, установка всё равно завершена (#176)', async () => {
    const botMake = vi.fn(async (opts: { method: string }) => {
      if (opts.method === 'imbot.v2.Bot.register') return okResult({ bot: { id: 1 } })
      if (opts.method === ENSURE_SCHEMA_METHOD) return okResult({ ok: false, created: [], existing: [], failed: ['UF_CRM_DEAL_DOGOVOR'] })
      return okResult(2)
    })
    const frame = frameStub({ isInstallMode: true, botMake })
    b24.isInit.mockReturnValue(true)
    b24.get.mockReturnValue(frame)

    const { state, schemaStatus, schemaMsg } = useInstall()
    await flush()

    expect(frame.installFinish).toHaveBeenCalledTimes(1)
    expect(state.value).toBe('done')
    expect(schemaStatus.value).toBe('partial')
    expect(schemaMsg.value).toContain('UF_CRM_DEAL_DOGOVOR')
  })

  it('ensureSchema провалился (нет scope crm) → schemaStatus=failed, установка не сорвана (#176)', async () => {
    const botMake = vi.fn(async (opts: { method: string }) => {
      if (opts.method === 'imbot.v2.Bot.register') return okResult({ bot: { id: 1 } })
      if (opts.method === ENSURE_SCHEMA_METHOD) return { isSuccess: false, getErrorMessages: () => ['INSUFFICIENT_SCOPE'], getData: () => ({ result: null }) }
      return okResult(2)
    })
    const frame = frameStub({ isInstallMode: true, botMake })
    b24.isInit.mockReturnValue(true)
    b24.get.mockReturnValue(frame)

    const { state, schemaStatus, schemaMsg, botWarning } = useInstall()
    await flush()

    expect(frame.installFinish).toHaveBeenCalledTimes(1)
    expect(state.value).toBe('done')
    expect(botWarning.value).toBe('') // бот в порядке — проблема только со схемой
    expect(schemaStatus.value).toBe('failed')
    expect(schemaMsg.value).toBeTruthy()
  })

  it('ensureSchema упал с исключением → best-effort: installFinish зовётся, schemaStatus=failed (#176)', async () => {
    const botMake = vi.fn(async (opts: { method: string }) => {
      if (opts.method === ENSURE_SCHEMA_METHOD) throw new Error('network')
      if (opts.method === 'imbot.v2.Bot.register') return okResult({ bot: { id: 1 } })
      return okResult(2)
    })
    const frame = frameStub({ isInstallMode: true, botMake })
    b24.isInit.mockReturnValue(true)
    b24.get.mockReturnValue(frame)

    const { state, schemaStatus } = useInstall()
    await flush()

    expect(frame.installFinish).toHaveBeenCalledTimes(1)
    expect(state.value).toBe('done')
    expect(schemaStatus.value).toBe('failed')
  })

  it('не install-режим: installFinish НЕ зовётся, state=already, схема не трогается', async () => {
    const frame = frameStub({ isInstallMode: false })
    b24.isInit.mockReturnValue(true)
    b24.get.mockReturnValue(frame)

    const { state, schemaStatus } = useInstall()
    await flush()

    expect(frame.installFinish).not.toHaveBeenCalled()
    expect(frame.actions.v2.call.make).not.toHaveBeenCalled() // бота/схему трогаем ТОЛЬКО при установке
    expect(state.value).toBe('already')
    expect(schemaStatus.value).toBe('pending') // донастройка не запускалась
  })

  it('идемпотентность: повторные триггеры не вызывают installFinish дважды', async () => {
    const frame = frameStub({ isInstallMode: true })
    b24.isInit.mockReturnValue(true)
    b24.get.mockReturnValue(frame)

    useInstall()
    await flush()
    watchCb?.() // ещё два срабатывания watch
    watchCb?.()
    await flush()

    expect(frame.installFinish).toHaveBeenCalledTimes(1)
  })

  it('гонка: get() сначала null — установка завершится на следующем триггере', async () => {
    const frame = frameStub({ isInstallMode: true })
    b24.isInit.mockReturnValue(true)
    b24.get.mockReturnValueOnce(undefined).mockReturnValue(frame)

    const { state } = useInstall() // 1-й триггер: get()=null → выходим, handled не ставим
    await flush()
    expect(frame.installFinish).not.toHaveBeenCalled()

    watchCb?.() // 2-й триггер: фрейм уже есть
    await flush()
    expect(frame.installFinish).toHaveBeenCalledTimes(1)
    expect(state.value).toBe('done')
  })

  it('ошибка installFinish: state=error и сообщение из ошибки', async () => {
    const frame = frameStub({
      isInstallMode: true,
      installFinish: vi.fn().mockRejectedValue(new Error('SDK fail'))
    })
    b24.isInit.mockReturnValue(true)
    b24.get.mockReturnValue(frame)

    const { state, errorMsg } = useInstall()
    await flush()

    expect(state.value).toBe('error')
    expect(errorMsg.value).toBe('SDK fail')
  })

  it('вне портала: фрейм не поднялся → по таймауту state=standalone', () => {
    vi.useFakeTimers()
    b24.isInit.mockReturnValue(false) // фрейм недоступен

    const { state } = useInstall() // immediate-watch → finishInstall выходит сразу
    expect(state.value).toBe('installing')

    mountedCb?.() // регистрируем таймер
    vi.advanceTimersByTime(STANDALONE_HINT_MS)
    expect(state.value).toBe('standalone')
    vi.useRealTimers()
  })

  it('медленный installFinish не перебивается standalone-таймаутом', async () => {
    vi.useFakeTimers()
    const frame = frameStub({ isInstallMode: true })
    b24.isInit.mockReturnValue(true)
    b24.get.mockReturnValue(frame)

    const { state } = useInstall() // handled=true ещё до таймера
    mountedCb?.()
    vi.advanceTimersByTime(STANDALONE_HINT_MS)

    expect(state.value).not.toBe('standalone')
    vi.useRealTimers()
  })
})
