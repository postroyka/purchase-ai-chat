import { useB24 } from './useB24'

// Подгонка высоты iframe Битрикс24 под реальную высоту контента (#fitwindow).
//
// Почему не штатный `parent.fitWindow()`: оболочка дашборда b24ui (B24DashboardGroup) фиксирована по
// вьюпорту (`position: fixed; inset: 0`), панель имеет `min-h-svh`, а тело панели (`[data-slot="body"]`)
// скроллится ВНУТРИ (`overflow-y-auto`). Из-за этого `document.documentElement.scrollHeight` всегда ≈
// высоте вьюпорта, а `fitWindow()` меряет именно его — и подгонка ничего не делает, скролл остаётся.
//
// Поэтому меряем высоту сами: «хром» вне тела (навбар = `panel.offsetHeight − body.offsetHeight`) плюс
// ПОЛНАЯ высота прокручиваемого тела (`body.scrollHeight` учитывает невидимую из-за скролла часть) — и
// явно ресайзим фрейм через `resizeWindow`. Перефит — на любое изменение высоты контента (ResizeObserver
// по контент-обёртке: загрузка картинок, раскрытие лога, смена статусов) и по готовности фрейма.
//
// Вне портала (standalone) — no-op: `b24.isInit()` ложно, ничего не шлём. Ограничение Битрикс24: фрейм
// можно только УВЕЛИЧИТЬ, не уменьшить — поэтому убираем скролл (нехватку высоты); «лишняя» высота при
// резком укорачивании контента остаётся (это лучше скролла).
export function useFitFrame(panelId: string) {
  const b24 = useB24()
  let ro: ResizeObserver | null = null

  async function fit(): Promise<void> {
    if (!b24.isInit()) return
    const frame = b24.get()
    if (!frame) return
    const panel = document.getElementById(panelId)
    const body = panel?.querySelector('[data-slot="body"]') as HTMLElement | null
    if (!panel || !body) return
    const height = panel.offsetHeight - body.offsetHeight + body.scrollHeight
    const width = Math.max(1, document.body.scrollWidth)
    if (height <= 0) return
    try {
      await frame.parent.resizeWindow(width, height)
    } catch {
      /* фрейм не готов / гонка — не критично */
    }
  }

  // nextTick (DOM обновился) + rAF (браузер сделал layout) — иначе меряем до перерасчёта высоты.
  function scheduleFit(): void {
    void nextTick(() => requestAnimationFrame(() => void fit()))
  }

  onMounted(() => {
    const content = document.getElementById(panelId)?.querySelector('[data-slot="body"]')?.firstElementChild
    // Наблюдаем КОНТЕНТ-обёртку (её высота растёт/падает с контентом), а не само тело — у тела высота
    // зафиксирована скролл-контейнером и не меняется при переполнении.
    if (content && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => scheduleFit())
      ro.observe(content)
    }
    scheduleFit()
  })

  onBeforeUnmount(() => {
    ro?.disconnect()
    ro = null
  })

  // Если фрейм инициализировался ПОСЛЕ монтирования страницы — подогнать сразу по готовности.
  watch(() => b24.isInit(), (ready) => {
    if (ready) scheduleFit()
  })

  return { fit }
}
