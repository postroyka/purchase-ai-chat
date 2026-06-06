import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT_PATH = join(__dirname, '..', 'prompts', 'main.md');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Run the procurement AI agent on a single file.
 *
 * Spawns `claude --print --bare --output-format json` as a child process,
 * passes the system prompt from `prompts/main.md` and a temporary MCP config,
 * then parses the structured JSON result.
 *
 * @param {string} filePath - Absolute path to the uploaded file (PDF/XLSX/DOCX)
 * @param {string|null} responsibleUserId - Bitrix24 user ID to assign the deal
 * @param {AgentConfig} [config] - Injectable config (overrides env vars; used by tests)
 * @returns {Promise<object>} Parsed agent result (matches prompts/main.md output schema)
 * @throws {Error} On timeout, non-zero exit, missing `claude` binary, or unparseable output
 *
 * @typedef {{
 *   claudeBin?: string,
 *   mcpUrl?: string,
 *   mcpToken?: string,
 *   model?: string,
 *   timeoutMs?: number,
 *   spawnFn?: typeof import('node:child_process').spawn,
 * }} AgentConfig
 */
export async function runAgent(filePath, responsibleUserId, config = {}) {
  const claudeBin = config.claudeBin ?? process.env.CLAUDE_CODE_BIN ?? 'claude';
  const mcpUrl = config.mcpUrl ?? process.env.MCP_SERVER_URL ?? 'http://mcp:3000/mcp';
  const mcpToken = config.mcpToken ?? process.env.NUXT_MCP_AUTH_TOKEN ?? '';
  const model = config.model ?? process.env.CLAUDE_MODEL ?? null;
  const timeoutMs = config.timeoutMs
    ?? parseInt(process.env.AGENT_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS), 10);
  const spawnFn = config.spawnFn ?? spawn;

  const systemPrompt = readFileSync(SYSTEM_PROMPT_PATH, 'utf8');
  const userMessage = [
    `FILE_PATH: ${filePath}`,
    `RESPONSIBLE_USER_ID: ${responsibleUserId ?? ''}`,
  ].join('\n');

  // Write MCP config to a temp file — the token must not appear in process args
  // (visible in `ps aux`), so we write it to a file only accessible to this process.
  const tmpDir = mkdtempSync(join(tmpdir(), 'procure-mcp-'));
  const mcpConfigPath = join(tmpDir, 'config.json');
  writeFileSync(mcpConfigPath, JSON.stringify(buildMcpConfig(mcpUrl, mcpToken)), {
    mode: 0o600, // owner-read-write only
  });

  try {
    return await spawnClaude({
      spawnFn,
      claudeBin,
      model,
      systemPrompt,
      userMessage,
      mcpConfigPath,
      timeoutMs,
    });
  } finally {
    // Always clean up — config file contains auth token
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Build MCP server config object for the `--mcp-config` flag.
 * @param {string} mcpUrl
 * @param {string} mcpToken
 * @returns {object}
 */
export function buildMcpConfig(mcpUrl, mcpToken) {
  const server = { url: mcpUrl };
  if (mcpToken) {
    server.headers = { Authorization: `Bearer ${mcpToken}` };
  }
  return { mcpServers: { 'procure-ai': server } };
}

function spawnClaude({ spawnFn, claudeBin, model, systemPrompt, userMessage, mcpConfigPath, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const args = [
      '--print',
      '--bare',                  // skip hooks/LSP/CLAUDE.md discovery in headless mode
      '--output-format', 'json', // structured JSON wrapper around the result
      '--system-prompt', systemPrompt,
      '--mcp-config', mcpConfigPath,
      '--dangerously-skip-permissions', // needed to read uploaded files without prompts
    ];
    if (model) args.push('--model', model);
    args.push(userMessage);

    const proc = spawnFn(claudeBin, args, {
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, timeoutMs);

    proc.stdout?.on('data', (chunk) => { stdout += chunk; });
    proc.stderr?.on('data', (chunk) => { stderr += chunk; });

    proc.on('error', (err) => {
      clearTimeout(timeoutHandle);
      if (err.code === 'ENOENT') {
        reject(new Error(
          `Claude Code CLI not found at "${claudeBin}". `
          + 'Set CLAUDE_CODE_BIN env var or ensure "claude" is in PATH.',
        ));
      } else {
        reject(err);
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timeoutHandle);

      if (timedOut) {
        reject(new Error(`Agent timed out after ${timeoutMs}ms`));
        return;
      }

      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
        reject(new Error(`Agent process exited with code ${code}: ${detail.slice(0, 500)}`));
        return;
      }

      // --output-format json wraps the response: { result: "<agent text>", is_error: bool, ... }
      let wrapper;
      try {
        wrapper = JSON.parse(stdout.trim());
      } catch {
        reject(new Error(`Agent output is not valid JSON. stdout: ${stdout.slice(0, 500)}`));
        return;
      }

      if (wrapper.is_error) {
        reject(new Error(`Agent returned an error: ${wrapper.result?.slice(0, 500) ?? 'unknown'}`));
        return;
      }

      const agentText = typeof wrapper.result === 'string' ? wrapper.result : stdout;
      const parsed = extractJson(agentText);
      if (!parsed) {
        reject(new Error(`Agent produced no JSON in its response. result: ${agentText.slice(0, 500)}`));
        return;
      }

      resolve(parsed);
    });
  });
}

/**
 * Extract the last valid JSON object or array from a string.
 * The agent may include prose before/after the JSON block.
 *
 * @param {string} text
 * @returns {object|null}
 */
export function extractJson(text) {
  // 1. Try the whole text as JSON (ideal: agent outputs pure JSON)
  try { return JSON.parse(text.trim()); } catch {}

  // 2. Try last fenced code block (```json ... ``` or ``` ... ```)
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```\s*$/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]); } catch {}
  }

  // 3. Find the rightmost } or ] and walk backwards to its matching opener.
  //    This handles agent output where JSON is preceded by explanation text.
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch !== '}' && ch !== ']') continue;
    const opener = ch === '}' ? '{' : '[';
    let depth = 0;
    for (let j = i; j >= 0; j--) {
      if (text[j] === ch) depth++;
      else if (text[j] === opener) depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(j, i + 1)); } catch {}
        break;
      }
    }
  }

  return null;
}
