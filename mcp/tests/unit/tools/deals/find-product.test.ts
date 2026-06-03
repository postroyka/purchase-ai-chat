import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpTool: <T,>(spec: T) => spec,
}))

interface ToolContent {
  content: { type: 'text'; text: string }[]
}

const tool = (await import('../../../../server/mcp/tools/deals/find-product')).default as unknown as {
  name: string
  inputSchema: z.ZodRawShape
  handler: (input: { vendorCode?: string, name?: string }) => Promise<ToolContent>
}

const schema = z.object(tool.inputSchema)

describe('b24_crm_find_product', () => {
  it('exposes the expected tool name', () => {
    expect(tool.name).toBe('b24_crm_find_product')
  })

  it('accepts vendorCode only', () => {
    expect(schema.safeParse({ vendorCode: 'A-1001' }).success).toBe(true)
  })

  it('accepts name only', () => {
    expect(schema.safeParse({ name: 'Цемент М500' }).success).toBe(true)
  })

  it('returns an error when neither vendorCode nor name is supplied', async () => {
    // Both fields are optional in the schema, so the empty call parses; the
    // handler is what enforces "at least one field".
    expect(schema.safeParse({}).success).toBe(true)

    const result = await tool.handler({})
    const payload = JSON.parse(result.content[0]!.text) as {
      error?: boolean
      stub?: boolean
      message: string
    }
    expect(payload.error).toBe(true)
    expect(payload.stub).toBeUndefined()
    expect(payload.message).toMatch(/at least one/i)
  })

  it('handler returns a stub when vendorCode is supplied', async () => {
    const result = await tool.handler({ vendorCode: 'A-1001' })
    const payload = JSON.parse(result.content[0]!.text) as {
      stub?: boolean
      error?: boolean
      vendorCode?: string
      message: string
    }
    expect(payload.stub).toBe(true)
    expect(payload.error).toBeUndefined()
    expect(payload.vendorCode).toBe('A-1001')
    expect(payload.message).toMatch(/not implemented/i)
  })

  it('handler returns a stub when only name is supplied', async () => {
    const result = await tool.handler({ name: 'Цемент М500' })
    const payload = JSON.parse(result.content[0]!.text) as { stub?: boolean, name?: string }
    expect(payload.stub).toBe(true)
    expect(payload.name).toBe('Цемент М500')
  })
})
