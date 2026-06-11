// Fetches the lifetime usage snapshot from the backend (GET /metrics/data) and keeps it fresh.
// Mirrors the auth pattern used on the upload page: a Bearer token from public runtime config.
// The fetch runs only on the client (onMounted) so prerendering the page never calls the API.

export interface MetricNamedCount { name: string, count: number }

export interface MetricsSnapshot {
  generatedAt: string
  economics: {
    enabled: boolean
    hourlyRateByn: number
    minutesPerPosition: number
    usdByn: number
    usdBynDate: string | null
    usdBynSource: 'nbrb' | 'nbrb-stale' | 'env' | string
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
  const config = useRuntimeConfig()

  const data = ref<MetricsSnapshot | null>(null)
  const error = ref<string | null>(null)
  const pending = ref(false)

  async function refresh() {
    pending.value = true
    try {
      const token = config.public.backendToken
      data.value = await $fetch<MetricsSnapshot>('/metrics/data', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: 'no-store'
      })
      error.value = null
    } catch (e: unknown) {
      error.value = extractError(e)
    } finally {
      pending.value = false
    }
  }

  // Auto-refresh while the page is mounted (client only). Paused on unmount.
  const { pause, resume } = useIntervalFn(refresh, REFRESH_MS, { immediate: false })
  onMounted(() => {
    refresh()
    resume()
  })
  onUnmounted(() => pause())

  return { data, error, pending, refresh }
}

function extractError(e: unknown): string {
  if (e && typeof e === 'object' && 'data' in e) {
    const data = (e as { data?: { error?: string } }).data
    if (data?.error) return data.error
  }
  if (e && typeof e === 'object' && 'status' in e && (e as { status?: number }).status === 401) {
    return 'Нет доступа (проверьте токен бэкенда)'
  }
  if (e instanceof Error) return e.message
  return 'Не удалось загрузить метрики'
}
