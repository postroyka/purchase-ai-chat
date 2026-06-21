// User-feedback channel (issue #182, channel 1 — "from the employee").
//
// Turns an in-app feedback submission (👍/👎/💡 + a free-text comment, tied to the job/deal the
// employee just processed) into a GitHub issue in the configured repo. The repo is PRIVATE at
// launch, so capturing job context (jobId, filename, deal id, who reported) is acceptable — it is
// exactly the signal a maintainer needs to reproduce an "article matched wrong / not a РФ supplier"
// report against the real case.
//
// Ported from mcp/server/utils/github-feedback.ts (the vetted agent-feedback client) and adapted to
// plain ESM + this backend's config. The security properties are carried over verbatim:
//   - never logs the token, the request URL, or the response body on error (an operator reading
//     container logs must not be able to recover the credential from a failure);
//   - the operator-supplied repo slug is validated (owner/repo, conservative charset) BEFORE it
//     enters the request path, so a misconfiguration can't retarget the API call;
//   - hostile characters (C0 controls, bidi overrides, zero-widths/BOM) are stripped so a crafted
//     comment can't Trojan-Source the GitHub issue list or corrupt the JSON payload;
//   - free text is HTML-escaped into a <pre><code> block so Markdown/HTML in it renders inert.

const GITHUB_API = 'https://api.github.com';

// Canonical feedback kinds → the label/UI text. Keep the keys in lockstep with the UI widget
// (ui/app/composables/useFeedback.ts) and the docs/FEEDBACK.md contract.
export const FEEDBACK_KINDS = {
  positive: '👍 Хорошо',
  problem: '👎 Проблема',
  suggestion: '💡 Предложение',
};

// Caps. The comment is the only large free-text field; 5000 chars is generous for a feedback note
// and well under any GitHub body limit. Title/context values are short by construction.
const MAX_COMMENT_LENGTH = 5000;
const MAX_TITLE_LENGTH = 120;
const MAX_CONTEXT_VALUE = 300;

export class GithubFeedbackError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'GithubFeedbackError';
    // 'NOT_CONFIGURED' | 'UPSTREAM' | 'NETWORK'
    this.code = code;
  }
}

// Hostile / accidentally-confusing characters. Spelled out with \u / \x escapes so a reviewer can
// verify what is stripped without trusting invisible code points in the source (embedding the
// literal characters here would itself be a Trojan Source vector against the reviewer):
//   - C0 controls except tab (0x09), LF (0x0A), CR (0x0D)
//   - bidi overrides (U+202A..U+202E, U+2066..U+2069)
//   - zero-width / BOM (U+200B..U+200D, U+FEFF)
// eslint-disable-next-line no-control-regex
const HOSTILE_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\u202a-\u202e\u2066-\u2069\u200b-\u200d\ufeff]/g;

/** Remove C0 controls, bidi overrides, zero-widths and BOM from arbitrary user-supplied text. */
export function stripHostileChars(input) {
  return String(input ?? '').replace(HOSTILE_CHARS, '');
}

/** Strip hostile chars from the comment and truncate to a sane maximum. */
export function sanitizeComment(input) {
  const stripped = stripHostileChars(input);
  if (stripped.length <= MAX_COMMENT_LENGTH) return stripped;
  return `${stripped.slice(0, MAX_COMMENT_LENGTH)}…\n\n[truncated to ${MAX_COMMENT_LENGTH} characters]`;
}

function escapeHtml(input) {
  return String(input ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** Returns the canonical kind if recognised, else null (the route rejects null with a 400). */
export function normalizeKind(kind) {
  return Object.prototype.hasOwnProperty.call(FEEDBACK_KINDS, kind) ? kind : null;
}

// Render one "- **Label:** value" context line, hostile-stripped + escaped + capped, or null when
// the value is empty (so the body never shows blank rows). Values are short, app-captured fields
// (ids, filename, version, user-agent) — escaping is defence-in-depth, not the primary control.
function contextLine(label, value) {
  const v = stripHostileChars(value).trim();
  if (!v) return null;
  return `- **${label}:** ${escapeHtml(v.slice(0, MAX_CONTEXT_VALUE))}`;
}

/**
 * Render the issue body: an app-captured context block followed by the employee's comment wrapped
 * in <pre><code> (so backticks/asterisks/HTML in it are inert). Mirrors the agent-feedback body
 * shape so maintainers triage both channels the same way.
 */
export function formatIssueBody({ kind, comment, context = {} }) {
  const ctxLines = [
    contextLine('Тип', FEEDBACK_KINDS[kind] ?? kind),
    contextLine('Задача (jobId)', context.jobId),
    contextLine('Файл', context.fileName),
    contextLine('Сделка', context.dealId ? `#${context.dealId}` : ''),
    contextLine('Кто сообщил', context.reporter),
    contextLine('Версия сборки', context.appVersion),
    contextLine('User-Agent', context.userAgent),
  ].filter(Boolean);

  // Strip hostile chars here too (not only in sanitizeComment): formatIssueBody is exported and may
  // be called directly with raw input (e.g. tests), so it must neutralise Trojan-Source/zero-widths
  // on its own rather than assume a pre-sanitised comment. escapeHtml then makes HTML/Markdown inert.
  const safeComment = escapeHtml(stripHostileChars(comment)).trim() || '(без текста)';

  return [
    '## Контекст',
    '',
    ...(ctxLines.length ? ctxLines : ['- _(контекст не передан)_']),
    '',
    '## Сообщение сотрудника',
    '',
    '<pre><code>',
    safeComment,
    '</code></pre>',
    '',
    '---',
    '_Отправлено через форму обратной связи в приложении (issue #182, канал «сотрудник»)._',
  ].join('\n');
}

/**
 * Build the { title, body, labels } for the GitHub issue from already-validated input.
 * Title = "[Обратная связь] <kind> · <first line of the comment>" (hostile-stripped, capped).
 */
export function buildIssue({ kind, comment, context = {} }) {
  const safeComment = sanitizeComment(comment);
  const firstLine = stripHostileChars(safeComment.split('\n')[0] ?? '').trim();
  const kindLabel = FEEDBACK_KINDS[kind] ?? kind;
  const titleText = firstLine ? `${kindLabel} · ${firstLine}` : kindLabel;
  const title = `[Обратная связь] ${titleText}`.slice(0, MAX_TITLE_LENGTH);
  const labels = ['user-feedback', `feedback:${kind}`];
  const body = formatIssueBody({ kind, comment: safeComment, context });
  return { title, body, labels };
}

// Tool name as referenced by the agent — bound to a safe shape before it goes in a title/label OR a
// dedup key (agent-feedback.js hashes on this same normalised form, so junk tool values can't each
// spawn a "distinct" near-identical issue). Exported for that reason.
export function safeToolName(tool) {
  const v = stripHostileChars(tool).trim();
  return /^[A-Za-z0-9_]{1,64}$/.test(v) ? v : '';
}

/**
 * Render the body of an AGENT-feedback issue (issue #182, channel «агент»). The note is the agent's
 * own "what hinders me / how to improve" about our MCP tools or the prompt. The agent processes
 * UNTRUSTED documents, so its text is treated exactly like user free text: hostile-stripped and
 * HTML-escaped into <pre><code>. Mirrors formatIssueBody's shape so both channels triage alike.
 */
export function formatAgentFeedbackBody({ tool, note, context = {} }) {
  const ctxLines = [
    contextLine('Инструмент', safeToolName(tool)),
    contextLine('Задача (jobId)', context.jobId),
    contextLine('Файл', context.fileName),
  ].filter(Boolean);

  const safeNote = escapeHtml(stripHostileChars(note)).trim() || '(без описания)';

  return [
    '## Обратная связь агента',
    '',
    'Автоматический сигнал от ИИ-агента обработки: что мешает в работе с нашими MCP-инструментами / промптом и как это можно улучшить.',
    '',
    '## Контекст',
    '',
    ...(ctxLines.length ? ctxLines : ['- _(контекст не передан)_']),
    '',
    '## Что мешает / как улучшить',
    '',
    '<pre><code>',
    safeNote,
    '</code></pre>',
    '',
    '---',
    '_Создано автоматически из результата агента (issue #182, канал «агент»). Текст агента — недоверенный (агент читает сторонние документы), поэтому экранирован._',
  ].join('\n');
}

/**
 * Build { title, body, labels, kind } for an AGENT-feedback issue. Unknown kind → 'problem'.
 * Title = "[Агент] <kind> · <tool?> · <first line>"; labels distinguish the channel (agent-feedback).
 */
export function buildAgentFeedbackIssue({ kind, tool, note, context = {} }) {
  const k = normalizeKind(kind) ?? 'problem';
  const safeNote = sanitizeComment(note);
  const firstLine = stripHostileChars(safeNote.split('\n')[0] ?? '').trim();
  const toolName = safeToolName(tool);
  // #219: заголовок без эмодзи (kind-слово без ведущего эмодзи) и компактнее (первая строка обрезана).
  const kindWord = (FEEDBACK_KINDS[k] ?? k).replace(/^\S+\s+/, '');
  const parts = [kindWord, toolName, firstLine.slice(0, 60)].filter(Boolean);
  const title = stripHostileChars(`[Агент] ${parts.join(' · ')}`).slice(0, MAX_TITLE_LENGTH);
  const labels = ['agent-feedback', `feedback:${k}`];
  const body = formatAgentFeedbackBody({ tool: toolName, note: safeNote, context });
  return { title, body, labels, kind: k };
}

/**
 * Best-effort privacy probe for the feedback repo (#190): GET /repos/{repo} and report whether it's
 * private. Used at startup to WARN if the repo that stores client context in issues is public. NEVER
 * throws — a network/permission/parse failure yields { ok:false, private:null } so the caller can log
 * "couldn't verify" rather than crash. The token is never logged here (the caller logs only the slug).
 *
 * @param {{ repo: string, token: string, fetchImpl?: typeof fetch, timeoutMs?: number }} input
 * @returns {Promise<{ ok: boolean, private: boolean|null, status: number }>}
 */
export async function checkRepoPrivacy({ repo, token, fetchImpl = fetch, timeoutMs = 5000 }) {
  if (!token || !repo) return { ok: false, private: null, status: 0 };
  const slug = String(repo);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug) || /(^|\/)\.\.?(\/|$)/.test(slug)) {
    return { ok: false, private: null, status: 0 };
  }
  let response;
  try {
    response = await fetchImpl(`${GITHUB_API}/repos/${slug}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'procure-ai-feedback',
      },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch {
    return { ok: false, private: null, status: 0 };
  }
  if (!response.ok) return { ok: false, private: null, status: response.status };
  let data;
  try {
    data = await response.json();
  } catch {
    return { ok: false, private: null, status: response.status };
  }
  // Only a boolean `private` is a definite answer. A 200 whose body omits it (shouldn't happen for
  // /repos, but be defensive) is UNDETERMINED → private:null, so the caller logs "couldn't verify"
  // rather than a false "PUBLIC" warning.
  const isPrivate = typeof data?.private === 'boolean' ? data.private : null;
  return { ok: true, private: isPrivate, status: response.status };
}

/**
 * Create a GitHub issue via the REST API. `fetchImpl` is injectable for tests.
 *
 * Throws GithubFeedbackError (codes NOT_CONFIGURED | UPSTREAM | NETWORK) and NEVER includes the
 * token, the URL, or the upstream body in the thrown message — the route logs only the code.
 *
 * @param {{ repo: string, token: string, title: string, body: string, labels?: string[],
 *           fetchImpl?: typeof fetch, timeoutMs?: number }} input
 * @returns {Promise<{ url: string, number: number }>}
 */
export async function createGithubIssue({ repo, token, title, body, labels = [], fetchImpl = fetch, timeoutMs = 10000 }) {
  if (!token) {
    throw new GithubFeedbackError('GitHub feedback token is not configured on the server.', 'NOT_CONFIGURED');
  }
  // Guard the operator-supplied repo before it lands in the request path. The host is fixed (no
  // SSRF), but an unvalidated value like `../../users/x` would still let a misconfiguration retarget
  // the API call. GitHub repo slugs are `owner/repo` over a conservative charset, and neither segment
  // may be `.`/`..` (which the charset above would otherwise admit — defence-in-depth path-traversal).
  const slug = String(repo);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug) || /(^|\/)\.\.?(\/|$)/.test(slug)) {
    throw new GithubFeedbackError('GitHub feedback repo is misconfigured — expected "owner/repo".', 'NOT_CONFIGURED');
  }

  const url = `${GITHUB_API}/repos/${repo}/issues`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'procure-ai-feedback',
      },
      body: JSON.stringify({ title, body, labels }),
      // Bound a hung GitHub so a /feedback POST can't pin a request; redirect:'error' is
      // defence-in-depth (the host is fixed, but never follow a 3xx to an unintended address).
      // timeoutMs is injectable so tests can exercise the abort→NETWORK path without a real 10s wait.
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch {
    // Deliberately swallow the cause — Node's fetch errors can include the URL and headers, which
    // would echo the bearer token into operator logs.
    throw new GithubFeedbackError('GitHub API is unreachable.', 'NETWORK');
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new GithubFeedbackError('GitHub rejected the feedback token (401/403). Rotate it and retry.', 'UPSTREAM');
    }
    if (response.status === 404) {
      throw new GithubFeedbackError(
        `GitHub returned 404 — the configured feedback repo (${repo}) is missing or unreachable.`,
        'UPSTREAM',
      );
    }
    throw new GithubFeedbackError(`GitHub returned ${response.status} when creating the feedback issue.`, 'UPSTREAM');
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new GithubFeedbackError('GitHub returned a non-JSON response.', 'UPSTREAM');
  }
  if (!data || !data.html_url || typeof data.number !== 'number') {
    throw new GithubFeedbackError('GitHub returned a malformed issue payload.', 'UPSTREAM');
  }
  return { url: data.html_url, number: data.number };
}
