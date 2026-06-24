import { describe, it, expect } from 'vitest'
import { failActiveFiles, type FailableJob } from '../app/utils/job-status'

const MSG = 'сервер недоступен'

describe('failActiveFiles (#280)', () => {
  it('переводит задание и НЕзавершённые файлы в error, завершённые не трогает', () => {
    const job: FailableJob = {
      jobId: 'j', status: 'processing',
      files: [
        { name: 'a', status: 'done', result: { ok: 1 } },
        { name: 'b', status: 'processing' },
        { name: 'c', status: 'pending' },
        { name: 'd', status: 'error', error: 'своя причина' },
        { name: 'e', status: 'cancelled' }
      ]
    } as unknown as FailableJob
    const out = failActiveFiles(job, MSG)
    expect(out.status).toBe('error')
    const byName = Object.fromEntries(out.files.map(f => [f.name as string, f]))
    // завершённый/отменённый — без изменений; processing/pending → error
    expect(byName.a!.status).toBe('done')
    expect(byName.b!.status).toBe('error')
    expect(byName.b!.error).toBe(MSG)
    expect(byName.c!.status).toBe('error')
    expect(byName.c!.error).toBe(MSG)
    expect(byName.d!.status).toBe('error')
    expect(byName.d!.error).toBe('своя причина') // собственная причина сохранена
    expect(byName.e!.status).toBe('cancelled')
  })

  it('иммутабельна (исходный job не мутируется)', () => {
    const job: FailableJob = { status: 'processing', files: [{ status: 'processing' }] } as FailableJob
    const out = failActiveFiles(job, MSG)
    expect(job.status).toBe('processing')
    expect(job.files[0]!.status).toBe('processing')
    expect(out).not.toBe(job)
    expect(out.files[0]!.status).toBe('error')
  })

  it('null/undefined возвращает как есть', () => {
    expect(failActiveFiles(null, MSG)).toBeNull()
    expect(failActiveFiles(undefined, MSG)).toBeUndefined()
  })
})
