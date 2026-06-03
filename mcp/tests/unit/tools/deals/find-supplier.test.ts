import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

// The toolkit's `defineMcpTool` just returns the spec at module load; mocking
// it lets us import the tool default and inspect `inputSchema` / `handler`
// without bootstrapping Nuxt.
vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpTool: <T,>(spec: T) => spec,
}))

interface ToolContent {
  content: { type: 'text'; text: string }[]
}

const tool = (await import('../../../../server/mcp/tools/deals/find-supplier')).default as unknown as {
  name: string
  inputSchema: z.ZodRawShape
  handler: (input: { unp: string }) => Promise<ToolContent>
}

const schema = z.object(tool.inputSchema)

describe('b24_crm_find_supplier', () => {
  it('exposes the expected tool name', () => {
    expect(tool.name).toBe('b24_crm_find_supplier')
  })

  it('accepts a valid 9-digit UNP', () => {
    expect(schema.safeParse({ unp: '191234567' }).success).toBe(true)
  })

  it.each([
    ['12345678', '8 digits'],
    ['1234567890', '10 digits'],
    ['12345678a', 'contains a letter'],
    ['', 'empty'],
    ['   ', 'whitespace'],
  ])('rejects an invalid UNP (%s — %s)', (unp) => {
    expect(schema.safeParse({ unp }).success).toBe(false)
  })

  it('handler returns a stub structure echoing the unp', async () => {
    const result = await tool.handler({ unp: '191234567' })
    const payload = JSON.parse(result.content[0]!.text) as {
      stub: boolean
      unp: string
      message: string
    }
    expect(payload.stub).toBe(true)
    expect(payload.unp).toBe('191234567')
    expect(payload.message).toMatch(/not implemented/i)
  })
})
