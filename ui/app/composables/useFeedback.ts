// Employee feedback (issue #182, channel «сотрудник»). Lets the person who processed a price-list
// rate the result (👍/👎 — виджет per-file, #218) + leave an OPTIONAL comment, tied to the file/job they
// ran. The submission becomes a GitHub issue in the backend's configured repo (see backend/feedback.js +
// docs/FEEDBACK.md). NB: `FeedbackKind` keeps `suggestion` for the AGENT channel; the employee widget
// offers only positive/problem.
//
// Goes through useApi, so the app-session cookie + X-PAI-Auth header authenticate the call — no
// token is ever shipped to the browser bundle (#41/#105 P1). The backend probe /feedback/config
// returns whether the channel is configured at all, so the UI can hide the widget when it isn't.

export type FeedbackKind = 'positive' | 'problem' | 'suggestion'

export interface FeedbackContext {
  jobId?: string
  fileName?: string
  dealId?: string
}

export interface FeedbackResult {
  ok: boolean
  // Present when the issue was created right away (HTTP 201). Absent when GitHub was briefly
  // unreachable and the backend queued the issue in its durable outbox (HTTP 202) — then `queued`
  // is true and the issue is delivered later by the backend (#190).
  url?: string
  number?: number
  queued?: boolean
}

export function useFeedback() {
  const { apiFetch } = useApi()
  const config = useRuntimeConfig()

  // Is the GitHub feedback channel configured on the backend? Failure (network/401) → treat as
  // disabled so the widget simply doesn't render rather than showing a broken control.
  async function isEnabled(): Promise<boolean> {
    try {
      const res = await apiFetch<{ enabled: boolean }>('/feedback/config')
      return Boolean(res?.enabled)
    } catch {
      return false
    }
  }

  // Submit a rating + comment. The app-captured context (jobId/fileName/dealId) plus the build
  // version are attached so a maintainer can reproduce the case; the backend validates + sanitises
  // everything before it reaches the issue.
  async function submit(kind: FeedbackKind, comment: string, context: FeedbackContext = {}): Promise<FeedbackResult> {
    return apiFetch<FeedbackResult>('/feedback', {
      method: 'POST',
      body: {
        kind,
        comment,
        context: {
          jobId: context.jobId,
          fileName: context.fileName,
          dealId: context.dealId,
          appVersion: config.public.gitSha
        }
      }
    })
  }

  return { isEnabled, submit }
}
