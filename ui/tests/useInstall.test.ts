import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { useInstall, STANDALONE_HINT_MS } from '../app/composables/useInstall'

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

/** Прогнать микрозадачи, чтобы доехали await'ы внутри finishInstall. */
async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

// Фейковый AjaxResult для actions.v2.call.make (регистрация бота при установке, #217).
const okResult = (result: unknown) => ({ isSuccess: true, getErrorMessages: () => [], getData: () => ({ result }) })

function frameStub(over: Partial<{ isInstallMode: boolean, installFinish: () => Promise<unknown>, botMake: ReturnType<typeof vi.fn> }> = {}) {
  const make = over.botMake ?? vi.fn(async (opts: { method: string }) =>
    okResult(opts.method === 'imbot.v2.Bot.register' ? { bot: { id: 1 } } : 2))
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

  it('install-режим: регистрирует бота через actions.v2.call.make ДО installFinish (#217)', async () => {
    const frame = frameStub({ isInstallMode: true })
    b24.isInit.mockReturnValue(true)
    b24.get.mockReturnValue(frame)

    const { state } = useInstall()
    await flush()

    const make = frame.actions.v2.call.make
    expect(make).toHaveBeenCalled()
    expect(make.mock.calls[0]![0].method).toBe('imbot.v2.Bot.register')
    expect(make.mock.calls[1]![0].method).toBe('imbot.command.register')
    expect(frame.installFinish).toHaveBeenCalledTimes(1)
    expect(state.value).toBe('done')
  })

  it('сбой регистрации бота НЕ срывает установку (best-effort): installFinish зовётся, state=done', async () => {
    const botMake = vi.fn().mockResolvedValue({ isSuccess: false, getErrorMessages: () => ['NO_SCOPE'], getData: () => ({ result: null }) })
    const frame = frameStub({ isInstallMode: true, botMake })
    b24.isInit.mockReturnValue(true)
    b24.get.mockReturnValue(frame)

    const { state } = useInstall()
    await flush()

    expect(botMake).toHaveBeenCalled() // попытка регистрации была
    expect(frame.installFinish).toHaveBeenCalledTimes(1) // но установка всё равно завершена
    expect(state.value).toBe('done')
  })

  it('не install-режим: installFinish НЕ зовётся, state=already', async () => {
    const frame = frameStub({ isInstallMode: false })
    b24.isInit.mockReturnValue(true)
    b24.get.mockReturnValue(frame)

    const { state } = useInstall()
    await flush()

    expect(frame.installFinish).not.toHaveBeenCalled()
    expect(state.value).toBe('already')
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
