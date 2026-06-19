// Fetches the lifetime usage snapshot from the backend (GET /metrics/data) and keeps it fresh.
// Mirrors the upload page: no browser token — auth via the app-session cookie + X-PAI-Auth header
// (added by useApi). The fetch runs only on the client (onMounted) so prerendering never calls it.

export interface MetricNamedCount { name: string, count: number }

export interface MetricsSnapshot {
  generatedAt: string
  economics: {
    enabled: boolean
    hourlyRateByn: number
    minutesPerPosition: number
    usdByn: number
    usdBynDate: string | null
    usdBynSource: 'nbrb' | 'nbrb-stale' | 'env'
    positions: number
    positionsNoArticle: number
    positionsNoArticlePct: number
    grossSavedByn: number
    modelCostByn: number
    netSavedByn: number
    lostNoArticleByn: number
  }
  totals: {
    uploads: number
    files: number
    filesDone: number
    filesError: number
    ok: number
    successRatePct: number
    costUsd: number
    costRuns: number
    avgCostUsd: number
    agentRuns: number
    avgAgentMs: number
    avgFileMs: number
  }
  outcomes: MetricNamedCount[]
  formats: MetricNamedCount[]
  extract: MetricNamedCount[]
  daily: { date: string, files: number }[]
}

const REFRESH_MS = 30_000

export function useMetrics() {
  const { apiFetch } = useApi()
  const data = ref<MetricsSnapshot | null>(null)
  const error = ref<string | null>(null)
  const pending = ref(false)

  // Cancel an in-flight request when a newer refresh starts or the component unmounts,
  // so a late response can't overwrite fresh data (or write into a dead ref).
  let controller: AbortController | null = null

  async function refresh() {
    controller?.abort()
    controller = new AbortController()
    const { signal } = controller
    pending.value = true
    try {
      // No token in the bundle (#41/#105 P1): app-session cookie + X-PAI-Auth (via useApi) in prod,
      // dev-proxy Bearer in dev.
      const snapshot = await apiFetch<MetricsSnapshot>('/metrics/data', {
        cache: 'no-store',
        signal
      })
      if (signal.aborted) return
      data.value = snapshot
      error.value = null
    } catch (e: unknown) {
      if (signal.aborted) return // superseded/unmounted — not a real error
      error.value = extractError(e)
    } finally {
      if (!signal.aborted) pending.value = false
    }
  }

  // Auto-refresh while mounted AND the tab is visible (client only): no point polling
  // /metrics/data (5× Redis hgetall) for a backgrounded tab left open for hours.
  const { pause, resume } = useIntervalFn(refresh, REFRESH_MS, { immediate: false })
  const visibility = useDocumentVisibility()
  watch(visibility, (state) => {
    if (state === 'visible') {
      refresh()
      resume()
    } else {
      pause()
    }
  })

  onMounted(() => {
    refresh()
    if (visibility.value === 'visible') resume()
  })
  onUnmounted(() => {
    pause()
    controller?.abort()
  })

  return { data, error, pending, refresh }
}

function extractError(e: unknown): string {
  if (e && typeof e === 'object' && 'data' in e) {
    const data = (e as { data?: { error?: string } }).data
    if (data?.error) return data.error
  }
  if (e && typeof e === 'object' && 'status' in e && (e as { status?: number }).status === 401) {
    return 'Нет доступа (401) — обновите страницу и войдите заново'
  }
  if (e instanceof Error) return e.message
  return 'Не удалось загрузить метрики'
}
