import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useFeedback } from '../app/composables/useFeedback'
import { useApi } from '../app/composables/useApi'

// useFeedback relies on Nuxt auto-imports (useApi/useRuntimeConfig/$fetch). We stub them as globals
// instead of booting a full Nuxt env — what matters is $fetch (the network), useApi (the wrapper that
// adds the CSRF header + credentials and ships NO token to the browser — #41/#105 P1), and
// useRuntimeConfig (the build version baked into the submission).
const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('$fetch', fetchMock)
  vi.stubGlobal('useApi', useApi) // real wrapper over the $fetch mock
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { gitSha: 'testsha' } }))
})

describe('useFeedback', () => {
  it('isEnabled reflects /feedback/config and fails closed on error', async () => {
    fetchMock.mockResolvedValueOnce({ enabled: true })
    expect(await useFeedback().isEnabled()).toBe(true)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('/feedback/config')
    expect(opts?.headers?.['X-PAI-Auth']).toBe('1') // even the probe goes through useApi

    fetchMock.mockResolvedValueOnce({ enabled: false })
    expect(await useFeedback().isEnabled()).toBe(false)

    // A rejected probe (network/401) must read as "disabled" so the widget simply hides.
    fetchMock.mockRejectedValueOnce(new Error('network'))
    expect(await useFeedback().isEnabled()).toBe(false)
  })

  it('submit posts to /feedback via useApi: X-PAI-Auth + credentials, NO token; carries context + build version', async () => {
    fetchMock.mockResolvedValue({ ok: true, url: 'https://example/issues/7', number: 7 })
    const res = await useFeedback().submit('problem', 'article wrong', { jobId: 'job-1', fileName: 'p.xlsx', dealId: '42' })
    expect(res).toMatchObject({ ok: true, number: 7 })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('/feedback')
    expect(opts?.method).toBe('POST')
    expect(opts?.headers?.['X-PAI-Auth']).toBe('1')
    expect(opts?.credentials).toBe('include')
    // P1 invariant: the request must NOT carry any token/Authorization/Bearer.
    expect(JSON.stringify(opts ?? {})).not.toMatch(/authorization|bearer|token/i)
    // Context + build version are forwarded; appVersion comes from runtimeConfig, not the caller.
    expect(opts?.body).toMatchObject({
      kind: 'problem',
      comment: 'article wrong',
      context: { jobId: 'job-1', fileName: 'p.xlsx', dealId: '42', appVersion: 'testsha' }
    })
  })
})
