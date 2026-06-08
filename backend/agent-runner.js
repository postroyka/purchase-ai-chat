import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT_PATH = join(__dirname, '..', 'prompts', 'main.md');

// Cached system prompt — file is immutable at runtime, no need to re-read on every call.
let _systemPrompt;
function getSystemPrompt() {
  return (_systemPrompt ??= readFileSync(SYSTEM_PROMPT_PATH, 'utf8'));
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
// Grace period between SIGTERM and SIGKILL on timeout — gives claude a chance
// to flush output and exit cleanly before we force-kill.
const SIGKILL_GRACE_MS = 5_000;

// Env vars that claude CLI needs — subset of process.env (principle of least privilege).
const AGENT_ENV_KEYS = [
  'PATH', 'HOME', 'USER', 'TMPDIR', 'TEMP', 'TMP',
  // Windows profile dirs — claude stores its auth session under %APPDATA%\Claude\
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH',
  'ANTHROPIC_API_KEY',        // required for API access (alternative to session auth)
  'CLAUDE_CODE_USE_BEDROCK',  // optional Bedrock provider
  'CLAUDE_CODE_USE_VERTEX',   // optional Vertex provider
  'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'GOOGLE_CLOUD_PROJECT', 'GOOGLE_APPLICATION_CREDENTIALS',
  'NODE_ENV',
];

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
 *   jobId?: string,
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
  const jobId = config.jobId ?? null;
  const spawnFn = config.spawnFn ?? spawn;

  const systemPrompt = getSystemPrompt();

  // Validate filePath to prevent prompt injection via crafted file names.
  // Path must not contain newlines, null bytes, or other control characters.
  if (/[\x00-\x1f]/.test(filePath)) {
    throw new Error(`Invalid filePath — contains control characters: ${JSON.stringify(filePath)}`);
  }

  const userMessage = [
    `FILE_PATH: ${filePath}`,
    `RESPONSIBLE_USER_ID: ${responsibleUserId ?? ''}`,
  ].join('\n');

  // Write MCP config to a temp file — the token must not appear in process args
  // (visible in `ps aux`), so we write it to a file accessible only to this process.
  let tmpDir;
  const mcpConfig = buildMcpConfig(mcpUrl, mcpToken);
  try {
    tmpDir = mkdtempSync(join(tmpdir(), 'procure-mcp-'));
    writeFileSync(join(tmpDir, 'config.json'), JSON.stringify(mcpConfig), {
      mode: 0o600, // owner-read-write only
    });
  } catch (err) {
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
    throw err;
  }
  const mcpConfigPath = join(tmpDir, 'config.json');

  try {
    return await spawnClaude({
      spawnFn,
      claudeBin,
      model,
      systemPrompt,
      userMessage,
      mcpConfigPath,
      timeoutMs,
      jobId,
    });
  } finally {
    // Always clean up — config file contains auth token.
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {
      console.error(`[agent-runner] failed to remove temp MCP config dir ${tmpDir}:`, e.message);
    }
  }
}

/**
 * Build the MCP server config object written to the `--mcp-config` temp file.
 *
 * @param {string} mcpUrl - HTTP(S) URL of the MCP server endpoint
 * @param {string|null|undefined} mcpToken - Bearer token; omitted when falsy
 * @returns {{ mcpServers: { 'procure-ai': { url: string, headers?: object } } }}
 */
export function buildMcpConfig(mcpUrl, mcpToken) {
  const server = { url: mcpUrl };
  if (mcpToken) {
    server.headers = { Authorization: `Bearer ${mcpToken}` };
  }
  return { mcpServers: { 'procure-ai': server } };
}

/** @param {string} text @returns {string} */
function redactToken(text) {
  return text.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
}

function buildAgentEnv() {
  const env = {};
  for (const key of AGENT_ENV_KEYS) {
    if (process.env[key] != null) env[key] = process.env[key];
  }
  return env;
}

function spawnClaude({
  spawnFn, claudeBin, model, systemPrompt, userMessage,
  mcpConfigPath, timeoutMs, jobId,
}) {
  const tag = jobId ? `[agent job=${jobId}]` : '[agent]';

  return new Promise((resolve, reject) => {
    const args = [
      '--print',
      '--bare',                  // skip hooks/LSP/CLAUDE.md discovery in headless mode
      '--output-format', 'json', // structured JSON wrapper around the result
      '--system-prompt', systemPrompt,
      '--mcp-config', mcpConfigPath,
      // Required so the agent can read uploaded files without interactive prompts.
      // Mitigated by: container runs as non-root, uploads are in a dedicated directory,
      // and filePath is validated above to prevent prompt injection.
      '--dangerously-skip-permissions',
    ];
    if (model) args.push('--model', model);
    args.push(userMessage);

    const t0 = Date.now();
    const proc = spawnFn(claudeBin, args, { env: buildAgentEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    // claude CLI 2.x waits ~3s for stdin when not attached to a TTY, then exits with code 1.
    // Closing stdin immediately signals EOF so the CLI proceeds without waiting.
    proc.stdin.end();

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let sigkillHandle = null;
    const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB guard against runaway output

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      // SIGKILL fallback if process ignores SIGTERM
      sigkillHandle = setTimeout(() => proc.kill('SIGKILL'), SIGKILL_GRACE_MS);
    }, timeoutMs);

    proc.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk;
    });
    proc.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk;
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutHandle);
      clearTimeout(sigkillHandle);
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
      clearTimeout(sigkillHandle);
      const durationMs = Date.now() - t0;

      if (timedOut) {
        console.error(`${tag} timed out after ${timeoutMs}ms`);
        reject(new Error(`Agent timed out after ${timeoutMs}ms`));
        return;
      }

      if (stderr.trim()) {
        // Log stderr even on success — may contain MCP warnings useful for debugging.
        console.warn(`${tag} stderr: ${redactToken(stderr).slice(0, 500)}`);
      }

      if (code !== 0) {
        const rawDetail = stderr.trim() || stdout.trim() || `exit code ${code}`;
        const detail = redactToken(rawDetail);
        reject(new Error(`Agent process exited with code ${code}: ${detail.slice(0, 500)}`));
        return;
      }

      console.log(`${tag} completed in ${durationMs}ms`);

      // --output-format json wraps the response: { result: "<agent text>", is_error: bool, ... }
      let wrapper;
      try {
        wrapper = JSON.parse(stdout.trim());
      } catch {
        reject(new Error(`Agent output is not valid JSON. stdout: ${stdout.slice(0, 500)}`));
        return;
      }

      if (wrapper.is_error) {
        reject(new Error(`Agent returned an error: ${String(wrapper.result ?? 'unknown').slice(0, 500)}`));
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
 * Tries three strategies in order:
 *   1. Whole text as JSON
 *   2. Last fenced code block (```json ... ``` or ``` ... ```)
 *   3. Rightmost well-formed {...} or [...] found by bracket-depth scan
 *
 * @param {string} text
 * @returns {object|array|null}
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
  //    Depth counters for { } and [ ] are independent so mixed nesting is handled
  //    correctly (e.g. {"a":[1,2]} — closing ] must not count toward { depth).
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch !== '}' && ch !== ']') continue;
    const isObj = ch === '}';
    let objDepth = 0;
    let arrDepth = 0;
    for (let j = i; j >= 0; j--) {
      if (text[j] === '}') objDepth++;
      else if (text[j] === '{') objDepth--;
      else if (text[j] === ']') arrDepth++;
      else if (text[j] === '[') arrDepth--;
      // We've reached the opener when the targeted counter hits zero.
      if ((isObj && objDepth === 0) || (!isObj && arrDepth === 0)) {
        try { return JSON.parse(text.slice(j, i + 1)); } catch {}
        break;
      }
    }
  }

  return null;
}
