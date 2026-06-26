// Durable source-file store for feedback (#332).
//
// Проблема: при разборе отзыва (private feedback-репо) нет исходного файла импорта — `processJob`
// удаляет папку задания сразу после обработки, а в Б24 файл кладёт только `create_deal`. Особенно
// больно, когда сделка НЕ создана: воспроизвести кейс нечем. Решение (#332): прикладывать исходный
// файл к feedback-issue durable-ссылкой, загружая его в ПРИВАТНЫЙ feedback-репо через GitHub
// contents API.
//
// ПРИВАТНОСТЬ (критично): это реальные счета с УНП/ценами/поставщиками. Загрузка РАЗРЕШЕНА ТОЛЬКО в
// репозиторий, ПОДТВЕРЖДЁННО приватный (checkRepoPrivacy → private===true). Если приватность не
// подтверждена (public / не удалось проверить / null) — НЕ загружаем (fail-closed). Главный код-репо
// публичный, утечка инвойса туда недопустима.
//
// Security carried over from feedback.js verbatim: токен никогда не попадает в логи/сообщения об
// ошибке; slug владельца/репо валидируется до попадания в путь запроса; AbortSignal + redirect:error.

const GITHUB_API = 'https://api.github.com';

// Кап размера загружаемого файла. contents API лимитирует ~файл, но base64 раздувает на ~33%, плюс
// это клиентские данные — держим консервативно. По умолчанию совпадает с MAX_FILE_SIZE_MB приложения.
const DEFAULT_MAX_UPLOAD_MB = 20;

export class FeedbackFileStoreError extends Error {
  constructor(message, code, { retryable = false } = {}) {
    super(message);
    this.name = 'FeedbackFileStoreError';
    // 'NOT_CONFIGURED' | 'NOT_PRIVATE' | 'TOO_LARGE' | 'UPSTREAM' | 'NETWORK'
    this.code = code;
    this.retryable = retryable;
  }
}

const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
function isValidSlug(slug) {
  return SLUG_RE.test(slug) && !/(^|\/)\.\.?(\/|$)/.test(slug);
}

/**
 * Привести имя файла к безопасному сегменту пути в репозитории: только [A-Za-z0-9._-], без `..`,
 * без слешей; пустое/опасное → 'file'. Длину режем. Кириллица/пробелы → '_' (имя в issue всё равно
 * показывается отдельной строкой контекста, здесь важна только безопасность пути).
 */
export function sanitizePathSegment(name, fallback = 'file') {
  const base = String(name ?? '').replace(/[/\\]/g, '_').trim();
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_') // схлопываем любые «..» (анти-traversal, хотя слешей уже нет)
    .replace(/^[._]+/, '')   // ведущие точки/подчёркивания убираем
    .slice(0, 100);
  return cleaned ? cleaned : fallback;
}

/**
 * Построить путь в репозитории для исходного файла отзыва: feedback-files/<jobId>/<fileName>.
 * Оба сегмента санитизируются (jobId — uuid, но не доверяем слепо).
 */
export function buildFeedbackFilePath(jobId, fileName) {
  return `feedback-files/${sanitizePathSegment(jobId, 'job')}/${sanitizePathSegment(fileName)}`;
}

/**
 * Загрузить файл в приватный feedback-репо через contents API (PUT /repos/{repo}/contents/{path}).
 * Возвращает { url } — html_url загруженного файла (durable-ссылка для issue).
 *
 * Бросает FeedbackFileStoreError и НИКОГДА не включает токен/URL/тело апстрима в сообщение.
 *
 * @param {{ repo: string, token: string, repoPrivate: boolean|null, jobId: string, fileName: string,
 *           content: Buffer, maxUploadMb?: number, fetchImpl?: typeof fetch, timeoutMs?: number }} input
 * @returns {Promise<{ url: string, path: string }>}
 */
export async function uploadFeedbackFile({
  repo, token, repoPrivate, jobId, fileName, content,
  maxUploadMb = DEFAULT_MAX_UPLOAD_MB, fetchImpl = fetch, timeoutMs = 15000,
}) {
  if (!token || !repo) {
    throw new FeedbackFileStoreError('Feedback file store is not configured (no token/repo).', 'NOT_CONFIGURED');
  }
  // ПРИВАТНОСТЬ fail-closed: грузим ТОЛЬКО при подтверждённо приватном репо. null/false → отказ.
  if (repoPrivate !== true) {
    throw new FeedbackFileStoreError('Refusing to upload source file: feedback repo is not confirmed private.', 'NOT_PRIVATE');
  }
  const slug = String(repo);
  if (!isValidSlug(slug)) {
    throw new FeedbackFileStoreError('Feedback repo is misconfigured — expected "owner/repo".', 'NOT_CONFIGURED');
  }
  if (!Buffer.isBuffer(content) || content.length === 0) {
    throw new FeedbackFileStoreError('Empty or invalid file content.', 'NOT_CONFIGURED');
  }
  const maxBytes = Math.max(1, maxUploadMb) * 1024 * 1024;
  if (content.length > maxBytes) {
    throw new FeedbackFileStoreError(`Source file exceeds the ${maxUploadMb}MB feedback-store limit.`, 'TOO_LARGE');
  }

  const path = buildFeedbackFilePath(jobId, fileName);
  const url = `${GITHUB_API}/repos/${slug}/contents/${path}`;
  const payload = {
    message: `chore(feedback): исходный файл для разбора отзыва (job ${sanitizePathSegment(jobId, 'job')}) (#332)`,
    content: content.toString('base64'),
  };

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'procure-ai-feedback',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch {
    // Swallow the cause (Node fetch errors can echo URL/headers → token leak). Transient → retryable.
    throw new FeedbackFileStoreError('GitHub API is unreachable.', 'NETWORK', { retryable: true });
  }

  // 422 = путь уже существует (повтор/ретрай того же job+file). Считаем это успехом-идемпотентностью:
  // достаём существующую ссылку через GET contents (если не вышло — не валим отзыв).
  if (response.status === 422) {
    const existing = await getExistingFileUrl({ slug, path, token, fetchImpl, timeoutMs }).catch(() => null);
    if (existing) return { url: existing, path };
    throw new FeedbackFileStoreError('File already exists at path and its URL could not be resolved.', 'UPSTREAM');
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new FeedbackFileStoreError('GitHub rejected the feedback token for contents write (401/403). Needs contents:write.', 'UPSTREAM');
    }
    if (response.status === 404) {
      throw new FeedbackFileStoreError('GitHub returned 404 — feedback repo missing/unreachable for contents write.', 'UPSTREAM');
    }
    const retryable = response.status === 429 || response.status >= 500;
    throw new FeedbackFileStoreError(`GitHub returned ${response.status} when uploading the source file.`, 'UPSTREAM', { retryable });
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new FeedbackFileStoreError('GitHub returned a non-JSON response.', 'UPSTREAM');
  }
  const htmlUrl = data?.content?.html_url;
  if (typeof htmlUrl !== 'string' || !htmlUrl) {
    throw new FeedbackFileStoreError('GitHub returned a malformed contents payload.', 'UPSTREAM');
  }
  return { url: htmlUrl, path };
}

/** GET contents to resolve an existing file's html_url (used on 422 idempotency). */
async function getExistingFileUrl({ slug, path, token, fetchImpl, timeoutMs }) {
  const response = await fetchImpl(`${GITHUB_API}/repos/${slug}/contents/${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'procure-ai-feedback',
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  });
  if (!response.ok) return null;
  const data = await response.json();
  const htmlUrl = data?.html_url;
  return typeof htmlUrl === 'string' && htmlUrl ? htmlUrl : null;
}
