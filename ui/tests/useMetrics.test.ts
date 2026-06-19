import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, watch } from 'vue'
import { useIntervalFn, useDocumentVisibility } from '@vueuse/core'
import { useMetrics } from '../app/composables/useMetrics'
import { useApi } from '../app/composables/useApi'

// useMetrics relies on Nuxt auto-imports (ref/watch/$fetch/useApi/useIntervalFn/
// useDocumentVisibility/lifecycle). We stub them as globals instead of booting a full Nuxt env —
// the ones that matter here are $fetch (the network) and useApi (the wrapper that adds the CSRF
// header + credentials). lifecycle hooks are no-ops so setup() doesn't auto-refresh.
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
  vi.stubGlobal('useApi', useApi) // real wrapper over the $fetch mock
})

describe('useMetrics — browser carries no token (#41/#105 P1)', () => {
  it('calls /metrics/data via useApi: X-PAI-Auth + credentials, NO Authorization/token', async () => {
    fetchMock.mockResolvedValue({ totals: { uploads: 1 } })
    const { refresh, data } = useMetrics()
    await refresh()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('/metrics/data')
    // useApi attaches the CSRF header and includes credentials (the session cookie).
    expect(opts?.headers?.['X-PAI-Auth']).toBe('1')
    expect(opts?.credentials).toBe('include')
    // The P1 invariant: the request must still NOT carry any token/Authorization/Bearer.
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
