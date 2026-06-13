import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeOk, makeFakeBitrix24 } from '../../_helpers/bitrix24-mock'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpTool: <T,>(spec: T) => spec,
}))

const fake = makeFakeBitrix24()
vi.mock('~/server/utils/bitrix24', () => ({ useBitrix24: () => fake.b24 }))

// The tool reads NUXT_UPLOADS_DIR at module load to build the containment base,
// so set it to a temp dir BEFORE importing the tool.
let uploadsDir: string
let pdfPath: string

uploadsDir = await mkdtemp(join(tmpdir(), 'uploads-'))
process.env.NUXT_UPLOADS_DIR = uploadsDir
pdfPath = join(uploadsDir, 'invoice.pdf')
await writeFile(pdfPath, Buffer.from('PDFDATA'))

const { default: tool } = await import('../../../../server/mcp/tools/deals/create-deal')

const baseInput = {
  supplierId: '10',
  responsibleUserId: '1',
  filePath: '', // set per-test
  processingLog: 'Processed OK',
  items: [{ name: 'Болт М8', priceExclVat: 1.5, quantity: 100 }],
}

describe('b24_pst_crm_create_deal', () => {
  beforeEach(() => { fake.v2Call.mockReset() })

  it('has correct tool name', () => {
    expect((tool as any).name).toBe('b24_pst_crm_create_deal')
  })

  it('reads the file, base64-encodes it and calls procuredeal.create', async () => {
    fake.v2Call.mockResolvedValue(fakeOk({ dealId: 999 }))

    const result = await (tool as any).handler({ ...baseInput, filePath: pdfPath })
    const payload = JSON.parse(result.content[0].text)

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'shef:purchase.api.procuredeal.create',
      params: expect.objectContaining({
        supplierId: '10',
        responsibleUserId: '1',
        fileName: 'invoice.pdf',
        fileContent: Buffer.from('PDFDATA').toString('base64'),
        processingLog: 'Processed OK',
        items: baseInput.items,
      }),
    })
    expect(payload).toEqual({ dealId: 999 })
    expect(fake.v3Call).not.toHaveBeenCalled()
  })

  it('includes contractId when provided', async () => {
    fake.v2Call.mockResolvedValue(fakeOk({ dealId: 1 }))

    await (tool as any).handler({ ...baseInput, filePath: pdfPath, contractId: '77' })

    expect((fake.v2Call.mock.calls[0]![0] as any).params.contractId).toBe('77')
  })

  it('omits contractId when not provided', async () => {
    fake.v2Call.mockResolvedValue(fakeOk({ dealId: 1 }))

    await (tool as any).handler({ ...baseInput, filePath: pdfPath })

    expect((fake.v2Call.mock.calls[0]![0] as any).params).not.toHaveProperty('contractId')
  })

  it('returns file_read_failed and does NOT call B24 on path traversal', async () => {
    const result = await (tool as any).handler({ ...baseInput, filePath: join(uploadsDir, '../../etc/passwd') })
    const payload = JSON.parse(result.content[0].text)

    expect(payload.error).toBe(true)
    expect(payload.code).toBe('file_read_failed')
    expect(fake.v2Call).not.toHaveBeenCalled()
  })

  it('returns file_read_failed when the file does not exist', async () => {
    const result = await (tool as any).handler({ ...baseInput, filePath: join(uploadsDir, 'missing.pdf') })
    const payload = JSON.parse(result.content[0].text)

    expect(payload.error).toBe(true)
    expect(payload.code).toBe('file_read_failed')
    expect(fake.v2Call).not.toHaveBeenCalled()
  })

  it('does not leak the offending filePath in the traversal error message', async () => {
    const result = await (tool as any).handler({ ...baseInput, filePath: join(uploadsDir, '../../etc/shadow') })
    const payload = JSON.parse(result.content[0].text)

    expect(payload.code).toBe('file_read_failed')
    expect(payload.message).not.toContain('shadow')
    expect(payload.message).not.toContain('etc')
  })

  it('returns file_too_large and does NOT call B24 when the file exceeds the limit', async () => {
    const bigPath = join(uploadsDir, 'big.bin')
    // NUXT_MAX_ATTACH_MB defaults to 25MB; write just over it.
    await writeFile(bigPath, Buffer.alloc(26 * 1024 * 1024, 0))

    const result = await (tool as any).handler({ ...baseInput, filePath: bigPath })
    const payload = JSON.parse(result.content[0].text)

    expect(payload.error).toBe(true)
    expect(payload.code).toBe('file_too_large')
    expect(fake.v2Call).not.toHaveBeenCalled()
  })

  it('propagates a Bitrix24 error response (!isSuccess) as a throw after reading the file', async () => {
    fake.v2Call.mockResolvedValue({ isSuccess: false, getData: () => ({ result: null }), getErrorMessages: () => ['DEAL_ADD_FAILED'] })

    await expect((tool as any).handler({ ...baseInput, filePath: pdfPath })).rejects.toThrow('DEAL_ADD_FAILED')
  })

  it('propagates a transport failure as a throw', async () => {
    fake.v2Call.mockRejectedValue(new Error('connection reset'))

    await expect((tool as any).handler({ ...baseInput, filePath: pdfPath })).rejects.toThrow()
  })

  it('rejects empty items array via Zod schema', () => {
    expect((tool as any).inputSchema.items.safeParse([]).success).toBe(false)
  })

  it('rejects negative priceExclVat via Zod schema', () => {
    expect((tool as any).inputSchema.items.safeParse([{ name: 'x', priceExclVat: -1, quantity: 1 }]).success).toBe(false)
  })

  it('rejects zero quantity via Zod schema', () => {
    expect((tool as any).inputSchema.items.safeParse([{ name: 'x', priceExclVat: 1, quantity: 0 }]).success).toBe(false)
  })

  it('rejects fractional quantity via Zod schema (unit is always шт → integer)', () => {
    expect((tool as any).inputSchema.items.safeParse([{ name: 'x', priceExclVat: 1, quantity: 2.5 }]).success).toBe(false)
  })

  it('rejects empty supplierId via Zod schema', () => {
    expect((tool as any).inputSchema.supplierId.safeParse('').success).toBe(false)
  })

  it('rejects empty responsibleUserId via Zod schema', () => {
    expect((tool as any).inputSchema.responsibleUserId.safeParse('').success).toBe(false)
  })

  it('rejects missing/empty contractId via Zod schema (contract is mandatory — see prompt step 3)', () => {
    expect((tool as any).inputSchema.contractId.safeParse(undefined).success).toBe(false)
    expect((tool as any).inputSchema.contractId.safeParse('').success).toBe(false)
  })

  it('rejects empty filePath via Zod schema', () => {
    expect((tool as any).inputSchema.filePath.safeParse('').success).toBe(false)
  })
})
