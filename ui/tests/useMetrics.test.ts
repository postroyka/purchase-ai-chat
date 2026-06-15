import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, watch } from 'vue'
import { useIntervalFn, useDocumentVisibility } from '@vueuse/core'
import { useMetrics } from '../app/composables/useMetrics'

// useMetrics relies on Nuxt auto-imports (ref/watch/$fetch/useIntervalFn/useDocumentVisibility/
// lifecycle). We stub them as globals instead of booting a full Nuxt env — the only one that
// matters for these tests is $fetch; lifecycle hooks are no-ops so setup() doesn't auto-refresh.
const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('watch', watch)
  vi.stubGlobal('useIntervalFn', useIntervalFn)
  vi.stubGlobal('useDocumentVisibility', useDocumentVisibility)
  vi.stubGlobal('onMounted', () => {})
  vi.stubGlobal('onUnmounted', () => {})
  vi.stubGlobal('$fetch', fetchMock)
})

describe('useMetrics — browser carries no token (#41/#105 P1)', () => {
  it('calls /metrics/data with NO Authorization header (auth via the Basic session)', async () => {
    fetchMock.mockResolvedValue({ totals: { uploads: 1 } })
    const { refresh, data } = useMetrics()
    await refresh()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('/metrics/data')
    // The P1 invariant: the request must not carry any token/Authorization.
    expect(opts?.headers).toBeUndefined()
    expect(JSON.stringify(opts ?? {})).not.toMatch(/authorization|bearer|token/i)
    expect(data.value).toEqual({ totals: { uploads: 1 } })
  })

  it('maps a 401 to a Basic-session message (not the old "token" wording)', async () => {
    fetchMock.mockRejectedValue({ status: 401 })
    const { refresh, error } = useMetrics()
    await refresh()

    expect(error.value).toMatch(/войдите заново/i)
    expect(error.value).not.toMatch(/токен/i)
  })
})
