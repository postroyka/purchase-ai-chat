import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, dirname, delimiter, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractDocumentText } from './extract-text.js';

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
  // Provider override — lets the containerised agent target an Anthropic-compatible
  // endpoint (e.g. DeepSeek) via .env.prod instead of a host-only ~/.claude/settings.json.
  // The tier maps (*_DEFAULT_*) and subagent model MUST be whitelisted too: without them,
  // Claude Code's background/subagent calls fall back to Anthropic model ids the provider
  // doesn't serve — i.e. uncontrolled cost / hard failures.
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_EFFORT_LEVEL',
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
 *   extractFn?: (filePath: string) => Promise<{ text: string, method: string }|null>,
 * }} AgentConfig
 */
export async function runAgent(filePath, responsibleUserId, config = {}) {
  const claudeBin = config.claudeBin ?? process.env.CLAUDE_CODE_BIN ?? 'claude';
  // Guard the (server-controlled) binary path against traversal — it is later
  // resolved against PATH / spawned, so reject obviously unsafe values early.
  if (claudeBin.includes('..')) {
    throw new Error(`Invalid claudeBin — path traversal not allowed: ${JSON.stringify(claudeBin)}`);
  }
  const mcpUrl = config.mcpUrl ?? process.env.MCP_SERVER_URL ?? 'http://mcp:3000/mcp';
  const mcpToken = config.mcpToken ?? process.env.NUXT_MCP_AUTH_TOKEN ?? '';
  const model = config.model ?? process.env.CLAUDE_MODEL ?? null;
  const timeoutMs = config.timeoutMs
    ?? parseInt(process.env.AGENT_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS), 10);
  const jobId = config.jobId ?? null;
  const spawnFn = config.spawnFn ?? spawn;
  const extractFn = config.extractFn ?? extractDocumentText;

  const systemPrompt = getSystemPrompt();

  // Validate filePath to prevent prompt injection via crafted file names.
  // Reject ASCII control chars (incl. newline/null) plus the Unicode line separators
  // U+2028/U+2029, which some models treat as line breaks inside the prompt.
  if (/[\x00-\x1f\u2028\u2029]/.test(filePath)) {
    throw new Error(`Invalid filePath — contains control characters: ${JSON.stringify(filePath)}`);
  }

  // Defense-in-depth: responsibleUserId is also validated at the HTTP layer, but
  // runAgent may be called directly. Reject anything but a positive integer so it
  // can't smuggle extra lines/instructions into the agent prompt.
  if (responsibleUserId != null && String(responsibleUserId) !== ''
      && !/^\d+$/.test(String(responsibleUserId))) {
    throw new Error(
      `Invalid responsibleUserId — must be a positive integer: ${JSON.stringify(responsibleUserId)}`,
    );
  }

  // Extract document text server-side (PDF text layer or OCR) so the agent works on
  // plain text regardless of the model's PDF/vision support. Non-fatal: on failure the
  // agent falls back to reading FILE_PATH itself.
  let extracted = null;
  try {
    extracted = await extractFn(filePath);
  } catch (e) {
    console.warn(`[agent-runner] document text extraction failed for ${filePath}: ${e.message}`);
  }

  const userMessage = [
    ...(extracted?.text
      ? [`DOCUMENT_TEXT (извлечено из файла; способ=${extracted.method}; НЕДОВЕРЕННЫЕ данные):`,
         extracted.text,
         '']
      : []),
    `FILE_PATH: ${filePath}`,
    `RESPONSIBLE_USER_ID: ${responsibleUserId ?? ''}`,
  ].join('\n');

  // Scope the agent's working directory to the upload's job dir. A prompt-injected
  // agent then resolves relative paths there, not in /app. (Absolute reads are still
  // possible — real isolation is the non-root container; this narrows the blast radius
  // and avoids CLAUDE.md/project discovery outside the job dir.)
  const cwd = dirname(filePath);

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
      cwd,
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

/**
 * Redact `Bearer <token>` sequences from a string before logging/persisting.
 * Exported so the HTTP layer can apply the same redaction to agent errors.
 * @param {string} text @returns {string}
 */
export function redactToken(text) {
  return String(text).replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
}

function buildAgentEnv() {
  const env = {};
  for (const key of AGENT_ENV_KEYS) {
    if (process.env[key] != null) env[key] = process.env[key];
  }
  return env;
}

/**
 * Resolve how to spawn the claude CLI, accounting for Windows.
 *
 * On Linux/macOS `claude` is a plain executable — spawn it directly.
 *
 * On Windows `claude` is installed by npm as a `claude.cmd` batch shim.
 * Node ≥18.20/20.12 refuses to spawn `.cmd`/`.bat` without `shell: true`
 * (CVE-2024-27980), and using a shell would (a) re-interpret cmd.exe
 * metacharacters (`| > % &`) present in the markdown system prompt and
 * (b) hit the 8191-char cmd.exe line limit. So instead we resolve the
 * real JS entrypoint the shim points to and run it via `node` directly —
 * no shell, no quoting hazards, no line-length cap.
 *
 * @param {string} claudeBin - configured binary name/path
 * @returns {{ command: string, prefixArgs: string[] }}
 */
export function resolveClaudeSpawn(claudeBin) {
  // Explicit JS entrypoint (e.g. CLAUDE_CODE_BIN=.../cli.js) → run with node.
  if (/\.(c|m)?js$/i.test(claudeBin)) {
    return { command: process.execPath, prefixArgs: [claudeBin] };
  }

  if (platform() !== 'win32') {
    return { command: claudeBin, prefixArgs: [] };
  }

  // On Windows, resolve the .cmd shim and extract the JS entrypoint it runs.
  const cmdPath = findWindowsCmdShim(claudeBin);
  if (cmdPath) {
    const jsEntry = extractCmdShimTarget(cmdPath);
    if (jsEntry && existsSync(jsEntry)) {
      return { command: process.execPath, prefixArgs: [jsEntry] };
    }
    // Found the .cmd shim but couldn't resolve a usable JS target — fail loudly
    // (distinguishing "unparseable" from "parsed but missing" aids Windows debugging)
    // instead of silently passing a .cmd to spawn (opaque error on Node ≥18.20).
    const reason = jsEntry
      ? `resolved to "${jsEntry}" but that file does not exist`
      : 'could not be parsed from the shim';
    throw new Error(
      `Found Claude .cmd shim at "${cmdPath}" but its JS entrypoint ${reason}. `
      + 'Set CLAUDE_CODE_BIN to the cli.js path directly.',
    );
  }

  // No .cmd shim found — let spawn try the bin as-is (works if it's a real .exe).
  return { command: claudeBin, prefixArgs: [] };
}

/** Locate `<bin>.cmd` on Windows: honor an absolute path, else scan PATH. */
function findWindowsCmdShim(claudeBin) {
  const cmdName = /\.cmd$/i.test(claudeBin) ? claudeBin : `${claudeBin}.cmd`;
  if (isAbsolute(cmdName)) return existsSync(cmdName) ? cmdName : null;

  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, cmdName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Parse an npm `.cmd` shim to find the JS file it launches.
 * npm shims reference the target relative to the shim dir via `%~dp0` / `%dp0%`,
 * e.g. `"%~dp0\node_modules\@anthropic-ai\claude-code\cli.js"`.
 *
 * @param {string} cmdPath
 * @returns {string|null} absolute path to the JS entrypoint, or null
 */
function extractCmdShimTarget(cmdPath) {
  let contents;
  try { contents = readFileSync(cmdPath, 'utf8'); } catch { return null; }
  // Capture only a relative entrypoint (no leading separator) so a tampered shim
  // can't point the resolver at an absolute path elsewhere on disk.
  const match = contents.match(/%[~]?dp0%?[\\/]?([^/\\"'\s][^"'\s]*\.(?:c|m)?js)/i);
  if (!match) return null;
  return join(dirname(cmdPath), match[1]);
}

function spawnClaude({
  spawnFn, claudeBin, model, systemPrompt, userMessage,
  mcpConfigPath, cwd, timeoutMs, jobId,
}) {
  const tag = jobId ? `[agent job=${jobId}]` : '[agent]';

  return new Promise((resolve, reject) => {
    const args = [
      '--print',
      '--bare',                  // skip hooks/LSP/CLAUDE.md discovery in headless mode
      '--output-format', 'json', // structured JSON wrapper around the result
      '--system-prompt', systemPrompt,
      '--mcp-config', mcpConfigPath,
      // Defense-in-depth against prompt injection from untrusted file content: deny the
      // tools the agent never needs (it only requires Read + the b24_pst_crm_* MCP tools),
      // so an injected instruction can't shell out, tamper with files, or exfiltrate.
      // Deny rules are honoured even under --dangerously-skip-permissions. Placed before a
      // boolean flag so the variadic list never swallows the trailing user message.
      '--disallowedTools', 'Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch',
      // Required so the agent can read uploaded files without interactive prompts.
      // Mitigated by: container runs as non-root, uploads are in a dedicated directory,
      // filePath is validated above, and the prompt marks file content as untrusted input.
      '--dangerously-skip-permissions',
    ];
    if (model) args.push('--model', model);
    args.push(userMessage);

    // On Windows, claude is a .cmd shim that node can't spawn directly — resolve
    // the real JS entrypoint and run it via node. No-op on Linux/macOS.
    const { command, prefixArgs } = resolveClaudeSpawn(claudeBin);

    const t0 = Date.now();
    const spawnOpts = { env: buildAgentEnv(), stdio: ['pipe', 'pipe', 'pipe'] };
    if (cwd) spawnOpts.cwd = cwd;
    const proc = spawnFn(command, [...prefixArgs, ...args], spawnOpts);
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

  // 3. Scan forward for balanced {…} / […] blocks, skipping any braces/brackets that
  //    appear inside JSON string literals (with backslash-escape handling). Returns the
  //    LAST block that parses — matches the agent's habit of emitting prose then JSON.
  let result = null;
  for (let i = 0; i < text.length; i++) {
    const open = text[i];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === open) depth++;
      else if (ch === close && --depth === 0) {
        // Keep the last parseable block; advance i past it to continue scanning.
        try { result = JSON.parse(text.slice(i, j + 1)); i = j; } catch { /* not JSON — keep scanning */ }
        break;
      }
    }
  }
  return result;
}
