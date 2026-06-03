import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpTool: <T,>(spec: T) => spec,
}))

interface ToolContent {
  content: { type: 'text'; text: string }[]
}

const tool = (await import('../../../../server/mcp/tools/deals/find-contract')).default as unknown as {
  name: string
  inputSchema: z.ZodRawShape
  handler: (input: { supplierId: string }) => Promise<ToolContent>
}

const schema = z.object(tool.inputSchema)

describe('b24_crm_find_contract', () => {
  it('exposes the expected tool name', () => {
    expect(tool.name).toBe('b24_crm_find_contract')
  })

  it('requires supplierId', () => {
    expect(schema.safeParse({}).success).toBe(false)
  })

  it('accepts a supplierId', () => {
    expect(schema.safeParse({ supplierId: '42' }).success).toBe(true)
  })

  it('handler returns a stub structure echoing the supplierId', async () => {
    const result = await tool.handler({ supplierId: '42' })
    const payload = JSON.parse(result.content[0]!.text) as {
      stub: boolean
      supplierId: string
      message: string
    }
    expect(payload.stub).toBe(true)
    expect(payload.supplierId).toBe('42')
    expect(payload.message).toMatch(/not implemented/i)
  })
})
