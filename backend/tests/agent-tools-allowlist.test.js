import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_MCP_TOOLS, MCP_SERVER_NAME } from '../agent-runner.js';

// #105 (P2) drift-guard: agent-runner строит строгий allowlist `mcp__<server>__<tool>` из
// захардкоженного AGENT_MCP_TOOLS. Если инструмент в mcp-overlay переименуют/удалят, а список тут
// не обновят — агент в проде МОЛЧА потеряет доступ к инструменту и все счета перестанут
// обрабатываться (юнит-тесты с моком spawn этого не ловят). Этот тест сверяет имена с фактическими
// определениями инструментов, чтобы рассинхрон падал в CI, а не в проде.
const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = join(__dirname, '..', '..', 'mcp-overlay', 'server', 'mcp', 'tools', 'deals');

function definedToolNames() {
  const names = new Set();
  for (const file of readdirSync(TOOLS_DIR)) {
    if (!file.endsWith('.ts')) continue;
    const src = readFileSync(join(TOOLS_DIR, file), 'utf8');
    for (const m of src.matchAll(/name:\s*['"]([a-z0-9_]+)['"]/gi)) names.add(m[1]);
  }
  return names;
}

describe('#105 P2 — allowlist agent tools sync with MCP overlay', () => {
  it('каждое имя из AGENT_MCP_TOOLS реально определено в mcp-overlay (нет рассинхрона)', () => {
    const defined = definedToolNames();
    const missing = AGENT_MCP_TOOLS.filter((t) => !defined.has(t));
    expect(missing, `имена есть в allowlist, но НЕ найдены среди инструментов overlay: ${missing.join(', ')}`).toEqual([]);
  });

  it('MCP_SERVER_NAME совпадает с именем сервера в buildMcpConfig', async () => {
    const { buildMcpConfig } = await import('../agent-runner.js');
    const cfg = buildMcpConfig('http://x/mcp', '');
    expect(Object.keys(cfg.mcpServers)).toContain(MCP_SERVER_NAME);
  });
});
