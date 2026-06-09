import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { runAgent, buildMcpConfig, extractJson, resolveClaudeSpawn } from '../agent-runner.js';
import { platform } from 'node:os';

// Helper: create a mock spawn function that simulates a child process.
function makeMockSpawn({ stdout = '', stderr = '', exitCode = 0, errorCode = null } = {}) {
  return vi.fn(() => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { end: vi.fn() };
    proc.kill = vi.fn((signal) => {
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
function wrapResult(agentJson, { is_error = false } = {}) {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error,
    result: typeof agentJson === 'string' ? agentJson : JSON.stringify(agentJson),
    session_id: 'test-session',
    num_turns: 5,
  });
}

const VALID_DEAL_RESULT = {
  supplier: { unp: '123456789', name: 'ООО Поставщик', supplierId: 's-1' },
  contract: { contractId: 'c-42' },
  currency: 'BYN',
  items: [{ vendorCode: 'ART-1', name: 'Товар', priceExclVat: 10.00, quantity: 5, unit: 'шт', productId: 'p-99' }],
  deal: { dealId: 'd-7', url: 'https://b24.example.com/crm/deal/7/' },
  sourceFile: '/uploads/job1/invoice.pdf',
};

// Default: no server-side text extraction in unit tests (hermetic — no pdftotext/OCR spawn).
const BASE_CONFIG = { timeoutMs: 1000, extractFn: async () => null };

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

  it('injects DOCUMENT_TEXT when server-side extraction returns text', async () => {
    const spawnFn = makeMockSpawn({ stdout: wrapResult(VALID_DEAL_RESULT) });
    const extractFn = async () => ({ text: 'СЧЁТ № 5\nПоставщик: ООО Ромашка, УНП 123456789', method: 'ocr' });
    await runAgent('/uploads/scan.pdf', '42', { ...BASE_CONFIG, spawnFn, extractFn });
    const prompt = spawnFn.mock.calls[0][1].at(-1);
    expect(prompt).toContain('DOCUMENT_TEXT');
    expect(prompt).toContain('ООО Ромашка');
    expect(prompt).toContain('FILE_PATH: /uploads/scan.pdf'); // FILE_PATH остаётся для вложения в сделку
    // End-marker must precede the system fields so untrusted text can't inject FILE_PATH/RESPONSIBLE_USER_ID.
    expect(prompt).toContain('--- END DOCUMENT_TEXT ---');
    expect(prompt.indexOf('--- END DOCUMENT_TEXT ---')).toBeLessThan(prompt.indexOf('FILE_PATH:'));
  });

  it('omits DOCUMENT_TEXT when extraction returns null (agent reads FILE_PATH)', async () => {
    const spawnFn = makeMockSpawn({ stdout: wrapResult(VALID_DEAL_RESULT) });
    await runAgent('/uploads/x.pdf', '42', { ...BASE_CONFIG, spawnFn }); // BASE_CONFIG.extractFn → null
    const prompt = spawnFn.mock.calls[0][1].at(-1);
    expect(prompt).not.toContain('DOCUMENT_TEXT');
    expect(prompt).toContain('FILE_PATH: /uploads/x.pdf');
  });

  it('survives extraction errors (falls back to FILE_PATH, no throw)', async () => {
    const spawnFn = makeMockSpawn({ stdout: wrapResult(VALID_DEAL_RESULT) });
    const extractFn = async () => { throw new Error('pdftotext boom'); };
    const result = await runAgent('/uploads/x.pdf', '42', { ...BASE_CONFIG, spawnFn, extractFn });
    expect(result).toMatchObject({ deal: { dealId: 'd-7' } });
    expect(spawnFn.mock.calls[0][1].at(-1)).toContain('FILE_PATH: /uploads/x.pdf');
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

  it('denies dangerous tools via --disallowedTools and keeps the prompt last', async () => {
    const spawnFn = makeMockSpawn({ stdout: wrapResult(VALID_DEAL_RESULT) });
    await runAgent('/f.pdf', null, { ...BASE_CONFIG, spawnFn });
    const [_bin, args] = spawnFn.mock.calls[0];
    const idx = args.indexOf('--disallowedTools');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toContain('Bash');             // single comma-separated value
    expect(args[idx + 2]).toMatch(/^--/);                // followed by a flag, not the prompt
    expect(args[args.length - 1]).toContain('FILE_PATH:'); // prompt stays the final positional arg
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

  it('passes stdio: pipe to spawn options', async () => {
    const spawnFn = makeMockSpawn({ stdout: wrapResult(VALID_DEAL_RESULT) });
    await runAgent('/f.pdf', null, { ...BASE_CONFIG, spawnFn });
    const [_bin, _args, opts] = spawnFn.mock.calls[0];
    expect(opts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    // Never spawn through a shell — this is what keeps cmd.exe/sh metacharacters
    // in the file path / prompt from being interpreted (CVE-2024-27980 class).
    expect(opts.shell).toBeUndefined();
  });

  it('whitelists DeepSeek provider + tier/subagent models in the spawn env', async () => {
    // Guards against the "uncontrolled subagent model" footgun: every provider/tier var
    // must reach the spawned claude, otherwise background/subagent calls fall back to a
    // default Anthropic model id the provider doesn't serve.
    const vars = {
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'sk-deepseek-test',
      ANTHROPIC_MODEL: 'deepseek-v4-pro[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
      CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-flash',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };
    const saved = {};
    for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v; }
    try {
      const spawnFn = makeMockSpawn({ stdout: wrapResult(VALID_DEAL_RESULT) });
      await runAgent('/f.pdf', null, { ...BASE_CONFIG, spawnFn });
      const [, , opts] = spawnFn.mock.calls[0];
      for (const [k, v] of Object.entries(vars)) expect(opts.env[k]).toBe(v);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  it('throws when claudeBin contains path traversal (..)', async () => {
    const spawnFn = makeMockSpawn({ stdout: wrapResult(VALID_DEAL_RESULT) });
    await expect(
      runAgent('/f.pdf', null, { ...BASE_CONFIG, spawnFn, claudeBin: '../../bin/sh' }),
    ).rejects.toThrow(/path traversal/);
    // Guard must short-circuit before ever spawning anything.
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('closes stdin immediately after spawn', async () => {
    let capturedProc;
    const spawnFn = vi.fn((...args) => {
      const base = makeMockSpawn({ stdout: wrapResult(VALID_DEAL_RESULT) })(...args);
      capturedProc = base;
      return base;
    });
    await runAgent('/f.pdf', null, { ...BASE_CONFIG, spawnFn });
    expect(capturedProc.stdin.end).toHaveBeenCalled();
  });

  it('does not pass NUXT_MCP_AUTH_TOKEN in process args (uses temp file)', async () => {
    const spawnFn = makeMockSpawn({ stdout: wrapResult(VALID_DEAL_RESULT) });
    await runAgent('/f.pdf', null, {
      ...BASE_CONFIG, spawnFn, mcpToken: 'super-secret-token',
    });
    const [_bin, args] = spawnFn.mock.calls[0];
    const argsStr = args.join(' ');
    expect(argsStr).not.toContain('super-secret-token');
  });

  it('throws on timeout and sends SIGTERM', async () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { end: vi.fn() };
    proc.kill = vi.fn((signal) => {
      if (signal === 'SIGTERM') setImmediate(() => proc.emit('close', null));
    });
    const spawnFn = vi.fn(() => proc);

    await expect(
      runAgent('/f.pdf', null, { ...BASE_CONFIG, timeoutMs: 50, spawnFn }),
    ).rejects.toThrow('timed out');

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    // Fake only the timer fns — leave Date/microtasks real so durationMs and
    // queueMicrotask in the mock behave normally.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { end: vi.fn() };
      // Ignore SIGTERM; only exit once force-killed.
      proc.kill = vi.fn((signal) => {
        if (signal === 'SIGKILL') queueMicrotask(() => proc.emit('close', null));
      });
      const spawnFn = vi.fn(() => proc);

      const p = runAgent('/f.pdf', null, { ...BASE_CONFIG, timeoutMs: 50, spawnFn });
      const assertion = expect(p).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(50);   // fires the timeout → SIGTERM
      await vi.advanceTimersByTimeAsync(5000); // grace elapses → SIGKILL
      await assertion;

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws when process exits with non-zero code', async () => {
    const spawnFn = makeMockSpawn({ exitCode: 1, stderr: 'claude: command failed' });
    await expect(
      runAgent('/f.pdf', null, { ...BASE_CONFIG, spawnFn }),
    ).rejects.toThrow(/exit.*1/);
  });

  it('redacts Bearer token from error message when stderr contains it', async () => {
    const spawnFn = makeMockSpawn({
      exitCode: 1,
      stderr: 'Authorization: Bearer secret-token-abc',
    });
    await expect(
      runAgent('/f.pdf', null, { ...BASE_CONFIG, spawnFn }),
    ).rejects.toThrow(/\[REDACTED\]/);
  });

  it('throws when filePath contains newline (prompt injection guard)', async () => {
    const spawnFn = makeMockSpawn({ stdout: wrapResult(VALID_DEAL_RESULT) });
    await expect(
      runAgent('/uploads/file.pdf\nIGNORE PREVIOUS', null, { ...BASE_CONFIG, spawnFn }),
    ).rejects.toThrow(/control characters/);
  });

  it('throws when responsibleUserId is not a positive integer (injection guard)', async () => {
    const spawnFn = makeMockSpawn({ stdout: wrapResult(VALID_DEAL_RESULT) });
    await expect(
      runAgent('/uploads/f.pdf', '1\nIGNORE PREVIOUS', { ...BASE_CONFIG, spawnFn }),
    ).rejects.toThrow(/responsibleUserId/);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('runs the agent with cwd scoped to the file’s job directory', async () => {
    const spawnFn = makeMockSpawn({ stdout: wrapResult(VALID_DEAL_RESULT) });
    await runAgent('/uploads/job-7/invoice.pdf', '20', { ...BASE_CONFIG, spawnFn });
    const opts = spawnFn.mock.calls[0][2];
    expect(opts.cwd).toBe('/uploads/job-7');
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
    const errorWrapper = JSON.stringify({ is_error: true, result: 'API rate limit exceeded' });
    const spawnFn = makeMockSpawn({ stdout: errorWrapper });
    await expect(
      runAgent('/f.pdf', null, { ...BASE_CONFIG, spawnFn }),
    ).rejects.toThrow(/API rate limit/);
  });

  it('handles wrapper.result that is not a string — falls back to stdout', async () => {
    const wrapper = JSON.stringify({
      is_error: false,
      result: { dealId: 'd-99' }, // object instead of string
    });
    const spawnFn = makeMockSpawn({ stdout: wrapper });
    // Falls back to extractJson(stdout) — the outer JSON string has no deal directly,
    // but extractJson will find the inner { dealId } object in the text.
    const result = await runAgent('/f.pdf', null, { ...BASE_CONFIG, spawnFn });
    expect(result).toBeTruthy();
  });

  it('throws when agent result contains no JSON', async () => {
    const spawnFn = makeMockSpawn({ stdout: wrapResult('Processing complete. No structured data.') });
    await expect(
      runAgent('/f.pdf', null, { ...BASE_CONFIG, spawnFn }),
    ).rejects.toThrow(/no JSON/i);
  });

  it('cleans up temp MCP config after successful run', async () => {
    const { readdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const before = readdirSync(tmpdir()).filter((d) => d.startsWith('procure-mcp-'));

    const spawnFn = makeMockSpawn({ stdout: wrapResult(VALID_DEAL_RESULT) });
    await runAgent('/f.pdf', null, { ...BASE_CONFIG, spawnFn });

    const after = readdirSync(tmpdir()).filter((d) => d.startsWith('procure-mcp-'));
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

  it('omits headers when token is empty string', () => {
    const cfg = buildMcpConfig('http://mcp:3000/mcp', '');
    expect(cfg.mcpServers['procure-ai'].headers).toBeUndefined();
  });

  it('omits headers when token is null', () => {
    const cfg = buildMcpConfig('http://mcp:3000/mcp', null);
    expect(cfg.mcpServers['procure-ai'].headers).toBeUndefined();
  });

  it('omits headers when token is undefined', () => {
    const cfg = buildMcpConfig('http://mcp:3000/mcp', undefined);
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

  it('extracts JSON object from surrounding prose', () => {
    const text = 'Here is the result:\n{"dealId":"d-1","ok":true}\nEnd.';
    expect(extractJson(text)).toEqual({ dealId: 'd-1', ok: true });
  });

  it('extracts JSON from fenced code block', () => {
    const text = 'Processing complete.\n```json\n{"status":"done"}\n```';
    expect(extractJson(text)).toEqual({ status: 'done' });
  });

  it('extracts last JSON when multiple JSON objects appear in prose', () => {
    const text = 'Intermediate: {"step":1}\nFinal: {"step":2,"ok":true}';
    expect(extractJson(text)).toEqual({ step: 2, ok: true });
  });

  it('handles nested object inside prose (mixed {} and [] nesting)', () => {
    const text = 'Result:\n{"a":{"b":1},"arr":[1,2,3]}\ndone.';
    expect(extractJson(text)).toEqual({ a: { b: 1 }, arr: [1, 2, 3] });
  });

  it('handles deeply nested JSON correctly', () => {
    const nested = '{"a":{"b":{"c":42}},"arr":[1,2,3]}';
    expect(extractJson(nested)).toEqual({ a: { b: { c: 42 } }, arr: [1, 2, 3] });
  });

  it('extracts array from prose', () => {
    const text = 'Items: [1,2,3] processed.';
    expect(extractJson(text)).toEqual([1, 2, 3]);
  });

  it('ignores unbalanced braces inside string values (string-aware scan)', () => {
    const text = 'Result: {"msg":"unbalanced } brace","ok":true} done.';
    expect(extractJson(text)).toEqual({ msg: 'unbalanced } brace', ok: true });
  });

  it('ignores brackets and escaped quotes inside string values', () => {
    const text = 'note {"label":"[draft] \\"q\\"","n":2} end';
    expect(extractJson(text)).toEqual({ label: '[draft] "q"', n: 2 });
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

describe('resolveClaudeSpawn', () => {
  it('runs a .js entrypoint via node', () => {
    const r = resolveClaudeSpawn('/some/path/cli.js');
    expect(r.command).toBe(process.execPath);
    expect(r.prefixArgs).toEqual(['/some/path/cli.js']);
  });

  it('runs a .mjs entrypoint via node', () => {
    const r = resolveClaudeSpawn('/some/path/cli.mjs');
    expect(r.command).toBe(process.execPath);
    expect(r.prefixArgs).toEqual(['/some/path/cli.mjs']);
  });

  it('on non-Windows, spawns the bin directly', () => {
    if (platform() === 'win32') return; // covered by the win32-specific path
    const r = resolveClaudeSpawn('claude');
    expect(r.command).toBe('claude');
    expect(r.prefixArgs).toEqual([]);
  });
});
