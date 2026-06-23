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
// явно ресайзим фрейм через `resizeWindow`. ResizeObserver по контент-обёртке перефитит на любые
// изменения высоты (картинки, раскрытие лога, смена статусов); плюс перефит на resize окна и по
// готовности фрейма.
//
// Вне портала (standalone) — no-op: `b24.isInit()` ложно, ничего не шлём. Ограничение Битрикс24: фрейм
// можно только УВЕЛИЧИТЬ, не уменьшить — поэтому убираем скролл (нехватку высоты); «лишняя» высота при
// резком укорачивании контента остаётся (это лучше скролла).
export function useFitFrame(panelId: string) {
  const b24 = useB24()
  let ro: ResizeObserver | null = null
  let observed: Element | null = null

  // ВАЖНО: B24DashboardPanel рендерит DOM-id как `${storageKey}-panel-${id}` (storageKey по умолчанию
  // "dashboard"), а НЕ переданный `id` дословно. Берём элемент по ОКОНЧАНИЮ id — устойчиво к storageKey.
  function panelEl(): HTMLElement | null {
    return document.querySelector(`[id$="-panel-${panelId}"]`)
  }
  function bodyEl(panel: HTMLElement | null): HTMLElement | null {
    return panel?.querySelector('[data-slot="body"]') ?? null
  }

  // Наблюдаем КОНТЕНТ-обёртку (её высота меняется с контентом), а не само тело (его высота зафиксирована
  // скролл-контейнером). Обёртка может пересоздаться (v-if/v-else на странице, напр. скелетон → данные
  // на метриках) — поэтому перецепляемся на актуальную при каждом замере.
  function ensureObserving(body: HTMLElement): void {
    if (!ro) return
    const content = body.firstElementChild
    if (content && content !== observed) {
      if (observed) ro.unobserve(observed)
      ro.observe(content)
      observed = content
    }
  }

  async function fit(): Promise<void> {
    if (!b24.isInit()) return
    const frame = b24.get()
    const panel = panelEl()
    const body = bodyEl(panel)
    if (!frame || !panel || !body) return
    ensureObserving(body)
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
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => scheduleFit())
    }
    // Ширина iframe могла поменяться (ресайз окна портала / сворачивание сайдбара) — перефитим.
    window.addEventListener('resize', scheduleFit)
    scheduleFit()
  })

  onBeforeUnmount(() => {
    window.removeEventListener('resize', scheduleFit)
    ro?.disconnect()
    ro = null
    observed = null
  })

  // Если фрейм инициализировался ПОСЛЕ монтирования страницы — подогнать сразу по готовности.
  watch(() => b24.isInit(), (ready) => {
    if (ready) scheduleFit()
  })

  return { fit }
}
