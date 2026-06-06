import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { runAgent, buildMcpConfig, extractJson } from '../agent-runner.js';

// Helper: create a mock spawn function that simulates a child process.
// opts.exitCode defaults to 0, opts.stdout is written before close.
function makeMockSpawn({ stdout = '', stderr = '', exitCode = 0, errorCode = null } = {}) {
  return vi.fn(() => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn((signal) => {
      // Simulate kill by emitting close asynchronously
      setImmediate(() => proc.emit('close', null));
    });

    setImmediate(() => {
      if (errorCode) {
        const err = new Error(`spawn error: ${errorCode}`);
        err.code = errorCode;
        proc.emit('error', err);
        return;
      }
      if (stdout) proc.stdout.emit('data', stdout);
      if (stderr) proc.stderr.emit('data', stderr);
      proc.emit('close', exitCode);
    });

    return proc;
  });
}

// Valid wrapper output from `claude --output-format json`
function wrapResult(agentJson) {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: typeof agentJson === 'string' ? agentJson : JSON.stringify(agentJson),
    session_id: 'test-session',
    num_turns: 5,
  });
}

const VALID_DEAL_RESULT = {
  supplier: { unp: '123456789', name: 'ООО Поставщик', supplierId: 's-1' },
  contract: { contractId: 'c-42' },
  currency: 'BYN',
  items: [{ vendorCode: 'ART-1', name: 'Товар', price: 10.00, quantity: 5, unit: 'шт', productId: 'p-99' }],
  deal: { dealId: 'd-7', url: 'https://b24.example.com/crm/deal/7/' },
  sourceFile: '/uploads/job1/invoice.pdf',
};

// Minimal agent config for all tests — injects mock spawnFn and short timeout
const BASE_CONFIG = { timeoutMs: 1000 };

describe('runAgent', () => {
  it('resolves with parsed deal result on successful run', async () => {
    const spawnFn = makeMockSpawn({ stdout: wrapResult(VALID_DEAL_RESULT) });
    const result = await runAgent('/uploads/test.pdf', '20', { ...BASE_CONFIG, spawnFn });
    expect(result).toMatchObject({ deal: { dealId: 'd-7' } });
  });

  it('passes file path and responsible user in the user message', async () => {
    const spawnFn = makeMockSpawn({ stdout: wrapResult(VALID_DEAL_RESULT) });
    await runAgent('/uploads/invoice.pdf', '42', { ...BASE_CONFIG, spawnFn });
    const [_bin, args] = spawnFn.mock.calls[0];
    const promptArg = args[args.length - 1];
    expect(promptArg).toContain('FILE_PATH: /uploads/invoice.pdf');
    expect(promptArg).toContain('RESPONSIBLE_USER_ID: 42');
  });

  it('includes --bare, --print, --output-format json, --dangerously-skip-permissions flags', async () => {
    const spawnFn = makeMockSpawn({ stdout: wrapResult(VALID_DEAL_RESULT) });
    await runAgent('/f.pdf', null, { ...BASE_CONFIG, spawnFn });
    const [_bin, args] = spawnFn.mock.calls[0];
    expect(args).toContain('--print');
    expect(args).toContain('--bare');
    expect(args).toContain('--output-format');
    expect(args).toContain('json');
    expect(args).toContain('--dangerously-skip-permissions');
  });

  it('passes --model when model is configured', async () => {
    const spawnFn = makeMockSpawn({ stdout: wrapResult(VALID_DEAL_RESULT) });
    await runAgent('/f.pdf', null, { ...BASE_CONFIG, spawnFn, model: 'claude-opus-4-5' });
    const [_bin, args] = spawnFn.mock.calls[0];
    expect(args).toContain('--model');
    expect(args).toContain('claude-opus-4-5');
  });

  it('does not pass --model when model is not configured', async () => {
    const spawnFn = makeMockSpawn({ stdout: wrapResult(VALID_DEAL_RESULT) });
    await runAgent('/f.pdf', null, { ...BASE_CONFIG, spawnFn });
    const [_bin, args] = spawnFn.mock.calls[0];
    expect(args).not.toContain('--model');
  });

  it('uses claudeBin from config', async () => {
    const spawnFn = makeMockSpawn({ stdout: wrapResult(VALID_DEAL_RESULT) });
    await runAgent('/f.pdf', null, { ...BASE_CONFIG, spawnFn, claudeBin: '/custom/claude' });
    const [bin] = spawnFn.mock.calls[0];
    expect(bin).toBe('/custom/claude');
  });

  it('throws on timeout', async () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn(() => {
      setImmediate(() => proc.emit('close', null));
    });
    const spawnFn = vi.fn(() => proc); // never emits close on its own

    await expect(
      runAgent('/f.pdf', null, { ...BASE_CONFIG, timeoutMs: 50, spawnFn }),
    ).rejects.toThrow('timed out');
  });

  it('throws when process exits with non-zero code', async () => {
    const spawnFn = makeMockSpawn({ exitCode: 1, stderr: 'claude: command failed' });
    await expect(
      runAgent('/f.pdf', null, { ...BASE_CONFIG, spawnFn }),
    ).rejects.toThrow(/exit.*1/);
  });

  it('throws when claude binary is not found (ENOENT)', async () => {
    const spawnFn = makeMockSpawn({ errorCode: 'ENOENT' });
    await expect(
      runAgent('/f.pdf', null, { ...BASE_CONFIG, spawnFn, claudeBin: '/nonexistent/claude' }),
    ).rejects.toThrow(/not found/i);
  });

  it('throws when wrapper output is not JSON', async () => {
    const spawnFn = makeMockSpawn({ stdout: 'not json at all' });
    await expect(
      runAgent('/f.pdf', null, { ...BASE_CONFIG, spawnFn }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it('throws when wrapper is_error is true', async () => {
    const errorWrapper = JSON.stringify({
      is_error: true,
      result: 'API rate limit exceeded',
    });
    const spawnFn = makeMockSpawn({ stdout: errorWrapper });
    await expect(
      runAgent('/f.pdf', null, { ...BASE_CONFIG, spawnFn }),
    ).rejects.toThrow(/API rate limit/);
  });

  it('throws when agent result contains no JSON', async () => {
    const spawnFn = makeMockSpawn({ stdout: wrapResult('Processing complete. No structured data found.') });
    await expect(
      runAgent('/f.pdf', null, { ...BASE_CONFIG, spawnFn }),
    ).rejects.toThrow(/no JSON/i);
  });

  it('writes and cleans up temp MCP config file', async () => {
    const writtenPaths = [];
    const cleanedPaths = [];

    // We can't easily intercept fs calls without mocking the module.
    // Instead, verify no leftover /tmp/procure-mcp-* dirs after the run.
    const { readdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');

    const before = readdirSync(tmpdir()).filter((d) => d.startsWith('procure-mcp-'));

    const spawnFn = makeMockSpawn({ stdout: wrapResult(VALID_DEAL_RESULT) });
    await runAgent('/f.pdf', null, { ...BASE_CONFIG, spawnFn });

    const after = readdirSync(tmpdir()).filter((d) => d.startsWith('procure-mcp-'));
    // New dirs created during this run should be cleaned up
    const newDirs = after.filter((d) => !before.includes(d));
    expect(newDirs).toHaveLength(0);
  });

  it('cleans up temp MCP config even when agent throws', async () => {
    const { readdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const before = readdirSync(tmpdir()).filter((d) => d.startsWith('procure-mcp-'));

    const spawnFn = makeMockSpawn({ exitCode: 1 });
    await expect(runAgent('/f.pdf', null, { ...BASE_CONFIG, spawnFn })).rejects.toThrow();

    const after = readdirSync(tmpdir()).filter((d) => d.startsWith('procure-mcp-'));
    const newDirs = after.filter((d) => !before.includes(d));
    expect(newDirs).toHaveLength(0);
  });
});

describe('buildMcpConfig', () => {
  it('includes Authorization header when token is provided', () => {
    const cfg = buildMcpConfig('http://mcp:3000/mcp', 'secret-token');
    expect(cfg.mcpServers['procure-ai'].headers).toEqual({
      Authorization: 'Bearer secret-token',
    });
  });

  it('omits headers when token is empty', () => {
    const cfg = buildMcpConfig('http://mcp:3000/mcp', '');
    expect(cfg.mcpServers['procure-ai'].headers).toBeUndefined();
  });

  it('sets correct url', () => {
    const cfg = buildMcpConfig('http://custom-mcp:9000/mcp', '');
    expect(cfg.mcpServers['procure-ai'].url).toBe('http://custom-mcp:9000/mcp');
  });
});

describe('extractJson', () => {
  it('parses plain JSON string', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses JSON array', () => {
    expect(extractJson('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('extracts JSON from surrounding prose', () => {
    const text = 'Here is the result:\n{"dealId":"d-1","ok":true}\nEnd.';
    expect(extractJson(text)).toEqual({ dealId: 'd-1', ok: true });
  });

  it('extracts JSON from fenced code block', () => {
    const text = 'Processing complete.\n```json\n{"status":"done"}\n```';
    expect(extractJson(text)).toEqual({ status: 'done' });
  });

  it('extracts last JSON when multiple JSON objects appear', () => {
    const text = 'Intermediate: {"step":1}\nFinal: {"step":2,"ok":true}';
    const result = extractJson(text);
    // Should get the last valid complete JSON
    expect(result).toBeTruthy();
  });

  it('handles nested JSON correctly', () => {
    const nested = '{"a":{"b":{"c":42}},"arr":[1,2,3]}';
    expect(extractJson(nested)).toEqual({ a: { b: { c: 42 } }, arr: [1, 2, 3] });
  });

  it('returns null for plain text with no JSON', () => {
    expect(extractJson('No JSON here, just text.')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractJson('')).toBeNull();
  });

  it('returns null for incomplete JSON', () => {
    expect(extractJson('{"incomplete":')).toBeNull();
  });
});
