import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpTool: <T,>(spec: T) => spec,
}))

interface ToolContent {
  content: { type: 'text'; text: string }[]
}

interface Item {
  productId?: string
  vendorCode?: string
  name: string
  priceExclVat: number
  quantity: number
}

interface CreateDealInput {
  supplierId: string
  contractId?: string
  responsibleUserId: string
  sourceFile: string
  items: Item[]
}

const tool = (await import('../../../../server/mcp/tools/deals/create-deal')).default as unknown as {
  name: string
  inputSchema: z.ZodRawShape
  handler: (input: CreateDealInput) => Promise<ToolContent>
}

const schema = z.object(tool.inputSchema)

const validItem: Item = { name: 'Цемент', priceExclVat: 12.5, quantity: 100 }

const validInput: CreateDealInput = {
  supplierId: '42',
  responsibleUserId: '5',
  sourceFile: 'invoice.pdf',
  items: [validItem],
}

describe('b24_crm_create_deal', () => {
  it('exposes the expected tool name', () => {
    expect(tool.name).toBe('b24_crm_create_deal')
  })

  it('accepts a fully-specified valid input', () => {
    expect(schema.safeParse(validInput).success).toBe(true)
  })

  it.each([
    ['supplierId', { ...validInput, supplierId: undefined }],
    ['responsibleUserId', { ...validInput, responsibleUserId: undefined }],
    ['sourceFile', { ...validInput, sourceFile: undefined }],
  ])('rejects input missing the required field %s', (_field, input) => {
    expect(schema.safeParse(input).success).toBe(false)
  })

  it('rejects an empty items array (min 1)', () => {
    expect(schema.safeParse({ ...validInput, items: [] }).success).toBe(false)
  })

  it('rejects a non-positive priceExclVat', () => {
    expect(
      schema.safeParse({ ...validInput, items: [{ ...validItem, priceExclVat: 0 }] }).success,
    ).toBe(false)
    expect(
      schema.safeParse({ ...validInput, items: [{ ...validItem, priceExclVat: -1 }] }).success,
    ).toBe(false)
  })

  it('rejects a non-positive quantity', () => {
    expect(
      schema.safeParse({ ...validInput, items: [{ ...validItem, quantity: 0 }] }).success,
    ).toBe(false)
    expect(
      schema.safeParse({ ...validInput, items: [{ ...validItem, quantity: -5 }] }).success,
    ).toBe(false)
  })

  it('rejects an item missing its name', () => {
    const badItem = { priceExclVat: 12.5, quantity: 1 } as unknown as Item
    expect(schema.safeParse({ ...validInput, items: [badItem] }).success).toBe(false)
  })

  it('handler returns a stub with itemCount', async () => {
    const result = await tool.handler({
      ...validInput,
      items: [validItem, { ...validItem, name: 'Песок' }],
    })
    const payload = JSON.parse(result.content[0]!.text) as {
      stub: boolean
      supplierId: string
      itemCount: number
      message: string
    }
    expect(payload.stub).toBe(true)
    expect(payload.supplierId).toBe('42')
    expect(payload.itemCount).toBe(2)
    expect(payload.message).toMatch(/not implemented/i)
  })
})
