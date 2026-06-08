// Windows-specific tests for resolveClaudeSpawn. The win32 branch never executes
// on the Linux CI runner, so we mock node:os.platform() and the fs lookups used to
// locate/parse the npm `.cmd` shim. node:path stays POSIX (the runner's default),
// so absolute paths here use POSIX form — the logic under test is separator-agnostic.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  platform: vi.fn(() => 'win32'),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal()),
  platform: h.platform,
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal()),
  existsSync: h.existsSync,
  readFileSync: h.readFileSync,
}));

const { resolveClaudeSpawn } = await import('../agent-runner.js');

describe('resolveClaudeSpawn (win32 branch)', () => {
  beforeEach(() => {
    h.platform.mockReturnValue('win32');
    h.existsSync.mockReset();
    h.readFileSync.mockReset();
  });

  it('resolves an absolute .cmd shim to "node <cli.js>"', () => {
    const SHIM = '/opt/claude/claude.cmd';
    const JS = '/opt/claude/node_modules/@anthropic-ai/claude-code/cli.js';
    h.existsSync.mockImplementation((p) => p === SHIM || p === JS);
    // Forward-slash npm shim form (regex must accept both / and \).
    h.readFileSync.mockReturnValue(
      '@"%~dp0/node_modules/@anthropic-ai/claude-code/cli.js" %*',
    );

    const r = resolveClaudeSpawn('/opt/claude/claude');
    expect(r.command).toBe(process.execPath);
    expect(r.prefixArgs).toHaveLength(1);
    expect(r.prefixArgs[0]).toMatch(/cli\.js$/);
  });

  it('falls back to the bin as-is when no .cmd shim is found (real .exe)', () => {
    h.existsSync.mockReturnValue(false); // neither the .cmd nor anything on PATH exists
    const r = resolveClaudeSpawn('/opt/claude/claude');
    expect(r.command).toBe('/opt/claude/claude');
    expect(r.prefixArgs).toEqual([]);
  });

  it('throws when the .cmd shim is found but its JS target cannot be parsed', () => {
    const SHIM = '/opt/claude/claude.cmd';
    h.existsSync.mockImplementation((p) => p === SHIM); // shim exists, JS target does not match
    h.readFileSync.mockReturnValue('@echo off\r\nrem unrecognised shim format\r\n');
    expect(() => resolveClaudeSpawn('/opt/claude/claude')).toThrow(/JS entrypoint could not be parsed/);
  });

  it('still runs an explicit .js entrypoint via node regardless of platform', () => {
    const r = resolveClaudeSpawn('/some/cli.js');
    expect(r.command).toBe(process.execPath);
    expect(r.prefixArgs).toEqual(['/some/cli.js']);
  });
});
