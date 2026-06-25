import Redis from 'ioredis';

/**
 * Lightweight, lifetime ("за всё время") usage metrics for the procurement pipeline.
 *
 * Design (issue #67, option A — thin):
 *  - Counters live in Redis hashes with NO TTL, so totals accumulate across restarts.
 *  - The signal is captured at the two pipeline chokepoints: POST /upload (recordUpload)
 *    and processJob per file (recordFile) — see backend/index.js.
 *  - Every method is BEST-EFFORT: a Redis hiccup must never fail a job, so errors are
 *    swallowed and logged. Falls back to an in-memory store when REDIS_URL is unset
 *    (dev/tests) — data is then lost on restart, which is fine for those contexts.
 *
 * @typedef {{
 *   recordUpload(arg: { fileCount?: number }): Promise<void>,
 *   recordFile(arg: {
 *     format?: string,
 *     status?: 'done'|'error',
 *     outcome?: string,
 *     durationMs?: number,
 *     positions?: number,
 *     positionsNoArticle?: number,
 *     speed?: 'fast'|'normal'|'slow'|null,
 *     agent?: { extractMethod?: string|null, costUsd?: number|null, agentDurationMs?: number, numTurns?: number|null, toolMs?: number|null }|null,
 *   }): Promise<void>,
 *   recordWarnings(codes: string[]): Promise<void>,
 *   recordFeedback(arg: { source: 'user'|'agent', kind?: string }): Promise<void>,
 *   recordMatching(arg: { result?: unknown }): Promise<void>,
 *   snapshot(): Promise<MetricsSnapshot>,
 *   ping(): Promise<void>,
 * }} Metrics
 */

/**
 * Shape returned by {@link Metrics.snapshot}. Mirrors `MetricsSnapshot` in
 * ui/app/composables/useMetrics.ts — keep the two in sync.
 *
 * @typedef {{
 *   generatedAt: string,
 *   economics: {
 *     enabled: boolean, hourlyRateByn: number, minutesPerPosition: number,
 *     usdByn: number, usdBynDate: string|null, usdBynSource: 'nbrb'|'nbrb-stale'|'env',
 *     positions: number, positionsNoArticle: number, positionsNoArticlePct: number,
 *     grossSavedByn: number, modelCostByn: number, netSavedByn: number, lostNoArticleByn: number,
 *   },
 *   totals: Record<string, number>,
 *   outcomes: Array<{ name: string, count: number }>,
 *   formats: Array<{ name: string, count: number }>,
 *   extract: Array<{ name: string, count: number }>,
 *   speed: Array<{ name: string, count: number }>,
 *   warnings: Array<{ name: string, count: number }>,
 *   feedback: { user: Array<{ name: string, count: number }>, agent: Array<{ name: string, count: number }> },
 *   matching: { suppliers: Array<{ name: string, count: number }>, multi: Array<{ name: string, count: number }>, articles: Array<{ name: string, count: number }> },
 *   daily: Array<{ date: string, files: number }>,
 * }} MetricsSnapshot
 */

const K = {
  totals: 'metrics:totals',
  outcomes: 'metrics:outcomes',
  formats: 'metrics:formats',
  extract: 'metrics:extract',
  daily: 'metrics:daily',
  // issue #207: распределение «быстро/норма/медленно» по total-времени файла (бакеты классифицирует
  // backend/index.js classifySpeed по порогам TIMING_FAST_MS/TIMING_SLOW_MS). NO-TTL total — агрегат,
  // не сырые тайминги (заказчик одобрил показ распределения в метриках). Считается только по УСПЕШНО
  // разобранным файлам (status done); ошибки/таймауты сюда не входят (их длительность не про скорость).
  speed: 'metrics:speed',
  // issue #182, channels «агент» + «сотрудник»: non-terminal agent quality signals (by code) and
  // feedback volume split by source (user 👍/👎/💡 vs agent developer-feedback), both NO-TTL totals.
  warnings: 'metrics:warnings',
  feedbackUser: 'metrics:feedback:user',
  feedbackAgent: 'metrics:feedback:agent',
  // issue #182, channel «MCP»: where matching fails. Counts supplier_not_found by УНП so the
  // dashboard can rank the suppliers that most often aren't matched (the «which suppliers fail» ask).
  matchingSuppliers: 'metrics:matching:suppliers',
  // issue #195 (телеметрия матчинга v2): мультиматч по шагам (инструмент молча взял min(id) при >1
  // совпадении) + несопоставленные артикулы (vendorCode не найден в каталоге) — оба derived из result.
  matchingMulti: 'metrics:matching:multi',
  matchingArticles: 'metrics:matching:articles',
};

// Cap on distinct supplier keys tracked (cardinality DoS guard — `unp` is agent-derived from an
// untrusted document). Once reached, further NEW suppliers fold into '__other__'.
const MATCHING_SUPPLIER_CAP = 300;

/** UTC day bucket key, e.g. "2026-06-10". */
function today() {
  return new Date().toISOString().slice(0, 10);
}

// Sanitize a metric label so a malformed agent error / odd extension can't create
// unbounded hash fields (cardinality DoS). Lowercase, [a-z0-9_], capped length.
function label(s, fallback = 'other') {
  if (typeof s !== 'string') return fallback;
  const v = s.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_]{0,39}$/.test(v) ? v : fallback;
}

// `outcome` partly originates from the agent's result (untrusted document content via
// prompt-injection). label() bounds the shape, but a regex-passing value would still add a
// unique hash field with no TTL. Pin to a known set; anything else → 'other' (cardinality cap).
const KNOWN_OUTCOMES = new Set([
  'ok', 'unknown', 'other',
  // file finished but NO deal was created — business error OR an unrecognised document (#192).
  // Distinct from 'ok' so the success-rate matches the UI ("успех = создана сделка").
  'no_deal',
  // business errors returned by the agent in result.error — keep in sync with prompts/main.md
  // (PR #71: supplier_not_found / contract_not_found replaced the old file_* codes;
  //  #97: foreign_supplier — российский поставщик отсекается по реквизитам ИНН/КПП).
  'tool_unavailable', 'unreadable_document', 'foreign_supplier', 'supplier_not_found', 'contract_not_found', 'unsupported_currency',
  // infra failures classified in backend/index.js (classifyAgentError)
  'timeout', 'cli_missing', 'agent_crash', 'bad_output', 'other_error',
]);
function outcomeLabel(s) {
  const v = label(s, 'unknown');
  return KNOWN_OUTCOMES.has(v) ? v : 'other';
}

// Non-terminal agent quality signals (issue #182, channel «агент»). Like outcomes these originate
// (indirectly) from untrusted document content, so pin to a known set — anything else → 'other'.
// Keep in sync with prompts/main.md (the `warnings[]` code list) and create_deal's PHP warnings.
const KNOWN_WARNING_CODES = new Set([
  'other',
  // surfaced from create_deal's response (prompts/main.md step 5)
  'no_items_matched', 'product_rows_failed', 'file_attach_failed', 'invalid_base64_file',
  'document_date_unparsed', 'timeline_comment_failed',
  // поставщик по УНП не найден — сделка создана без компании (контроллер проставляет warning)
  'supplier_not_found',
  // agent-detected during matching (step 4)
  'articles_not_in_catalog', 'items_without_article',
  // agent-detected during contract lookup (step 3): договор не найден — сделка создана без договора.
  // contract_substituted — legacy (#269, фолбэк на активный договор отменён), оставлен для старых данных.
  'contract_not_found', 'contract_substituted',
]);
function warningLabel(s) {
  const v = label(s, 'other');
  return KNOWN_WARNING_CODES.has(v) ? v : 'other';
}

// Feedback kinds — shared by the user channel (👍/👎/💡) and the agent channel. label() + this
// allowlist bound cardinality (agent output is untrusted). Mirror backend/feedback.js FEEDBACK_KINDS.
const KNOWN_FEEDBACK_KINDS = new Set(['positive', 'problem', 'suggestion', 'perf', 'other']);
function feedbackKindLabel(s) {
  const v = label(s, 'other');
  return KNOWN_FEEDBACK_KINDS.has(v) ? v : 'other';
}

// Бакеты скорости разбора файла (issue #207). Классификацию делает classifySpeed в backend/index.js;
// сюда приходит готовый бакет — пишем только валидный, иначе не считаем (null/мусор → пропуск).
const KNOWN_SPEED_BUCKETS = new Set(['fast', 'normal', 'slow']);

// A supplier УНП used as a hash field (issue #182 MCP channel). Belarus УНП is numeric (~9 digits);
// keep only digits and bound the length, so a prompt-injected `unp` (arbitrary document text) can't
// create giant/odd fields or pollute the supplier ranking. Returns null for junk (→ not recorded).
function supplierKeyLabel(s) {
  const v = String(s ?? '').replace(/\D/g, '');
  return v.length >= 4 && v.length <= 16 ? v : null;
}

// issue #195: шаги матчинга, где возможен мультиматч. Пин к известному набору (значение из result
// агента — недоверенное), иначе → null (не считаем).
const KNOWN_MATCH_STEPS = new Set(['supplier', 'contract', 'product']);
function matchStepLabel(s) {
  const v = String(s ?? '').trim().toLowerCase();
  return KNOWN_MATCH_STEPS.has(v) ? v : null;
}

// issue #195: артикул (vendorCode) как hash-поле. Артикул — из недоверенного документа, поэтому
// чистим (буквы/цифры/.-_/ , без пробелов), приводим к верхнему регистру и ограничиваем длину, чтобы
// не плодить гигантские/мусорные поля. Возвращает null для пустого/мусорного. Cardinality-кап ниже.
const MATCHING_ARTICLE_CAP = 300;
function articleKeyLabel(s) {
  const v = String(s ?? '').trim().toUpperCase().replace(/[^A-Z0-9._/-]/g, '');
  return v.length >= 1 && v.length <= 40 ? v : null;
}

function warn(ctx, e) {
  console.warn(`[metrics] ${ctx} failed: ${e?.message ?? e}`);
}

/**
 * @param {{ redisUrl?: string, hourlyRateByn?: number, minutesPerPosition?: number, usdBynRate?: number,
 *           getUsdByn?: () => Promise<{ rate: number, date?: string|null, source?: string }> }} [config]
 * @returns {Metrics}
 */
export function createMetrics(config = {}) {
  const redisUrl = config.redisUrl ?? process.env.REDIS_URL ?? '';
  const backend = redisUrl ? redisBackend(redisUrl) : memoryBackend();
  // Economic model (issue #75). hourlyRateByn = cost of an employee-hour to the company
  // (salary + payroll taxes). 0 disables the savings estimate. Defaults are placeholders
  // to confirm with the client; all tunable via env. usdByn here is the *fallback* — when
  // getUsdByn is provided (live NB RB rate, see nbrb-rate.js) it takes precedence per snapshot.
  const econ = {
    hourlyRateByn: num(config.hourlyRateByn ?? process.env.HOURLY_RATE_BYN, 18),
    minutesPerPosition: num(config.minutesPerPosition ?? process.env.MINUTES_PER_POSITION, 2),
    usdByn: num(config.usdBynRate ?? process.env.USD_BYN_RATE, 3.3),
  };
  return makeApi(backend, econ, config.getUsdByn ?? null);
}

function makeApi(b, econ = { hourlyRateByn: 0, minutesPerPosition: 2, usdByn: 3.3 }, getUsdByn = null) {
  async function recordUpload({ fileCount = 0 } = {}) {
    try {
      await b.batch([
        ['hincrby', K.totals, 'uploads', 1],
        ['hincrby', K.totals, 'files', Math.max(0, Math.trunc(Number(fileCount) || 0))],
      ]);
    } catch (e) { warn('recordUpload', e); }
  }

  async function recordFile({ format, status, outcome, durationMs = 0, agent = null, positions = 0, positionsNoArticle = 0, speed = null } = {}) {
    try {
      const out = outcomeLabel(outcome);
      const ops = [
        ['hincrby', K.totals, status === 'done' ? 'files_done' : 'files_error', 1],
        ['hincrby', K.totals, 'file_ms', Math.max(0, Math.round(Number(durationMs) || 0))],
        ['hincrby', K.formats, label(format, 'unknown'), 1],
        ['hincrby', K.outcomes, out, 1],
        ['hincrby', K.daily, today(), 1],
      ];
      // Распределение скорости разбора (issue #207): считаем только валидный бакет (fast/normal/slow).
      if (KNOWN_SPEED_BUCKETS.has(speed)) ops.push(['hincrby', K.speed, speed, 1]);
      if (out === 'ok') ops.push(['hincrby', K.totals, 'ok', 1]);
      // Line-item counts drive the savings/loss estimate (#75). #264: positionsNoArticle теперь
      // приходит СТРУКТУРНО от агента (позиции без артикула в items[] не лежат), поэтому НЕ зажимаем
      // его по `pos` (matched) и НЕ гейтим по `pos > 0` — иначе документ, где ВСЕ позиции без
      // артикула (matched = 0), не записал бы потерю вовсе (та самая инверсия метрики из #264).
      const pos = Math.max(0, Math.trunc(Number(positions) || 0));
      const noArt = Math.max(0, Math.trunc(Number(positionsNoArticle) || 0));
      if (pos > 0) ops.push(['hincrby', K.totals, 'positions', pos]);
      if (noArt > 0) ops.push(['hincrby', K.totals, 'positions_no_article', noArt]);
      if (agent) {
        ops.push(['hincrby', K.totals, 'agent_runs', 1]);
        ops.push(['hincrby', K.totals, 'agent_ms', Math.max(0, Math.round(Number(agent.agentDurationMs) || 0))]);
        // Число ходов агента (#222 «думает vs ищет»): сумма по прогонам → среднее в snapshot.
        if (Number.isFinite(agent.numTurns)) {
          ops.push(['hincrby', K.totals, 'agent_turns', Math.max(0, Math.round(Number(agent.numTurns)))]);
        }
        // Время агента в инструментах (#262 Шаг 2 ≈ ожидание MCP/REST к Bitrix24). Отдельный счётчик
        // прогонов: toolMs есть не всегда (обёртка может не отдать duration_api_ms), и среднее должно
        // делиться только на прогоны С известным toolMs, а не на все agent_runs.
        if (Number.isFinite(agent.toolMs)) {
          ops.push(['hincrby', K.totals, 'tool_ms', Math.max(0, Math.round(Number(agent.toolMs)))]);
          ops.push(['hincrby', K.totals, 'tool_runs', 1]);
        }
        if (typeof agent.extractMethod === 'string') {
          ops.push(['hincrby', K.extract, label(agent.extractMethod, 'unknown'), 1]);
        }
        if (typeof agent.costUsd === 'number' && Number.isFinite(agent.costUsd) && agent.costUsd >= 0) {
          ops.push(['hincrbyfloat', K.totals, 'cost_usd', agent.costUsd]);
          ops.push(['hincrby', K.totals, 'cost_runs', 1]);
        }
      }
      await b.batch(ops);
    } catch (e) { warn('recordFile', e); }
  }

  // Non-terminal agent quality signals for a file (issue #182, channel «агент»). Bounded list,
  // each code pinned to the allowlist. Best-effort — never fails a job.
  async function recordWarnings(codes = []) {
    try {
      const list = (Array.isArray(codes) ? codes : []).filter((c) => typeof c === 'string').slice(0, 20);
      if (!list.length) return;
      await b.batch(list.map((c) => ['hincrby', K.warnings, warningLabel(c), 1]));
    } catch (e) { warn('recordWarnings', e); }
  }

  // One feedback submission, split by source (user 👍/👎/💡 vs agent developer-feedback) and kind.
  // Counts attempts to submit, regardless of whether a GitHub issue was actually opened (deduped).
  async function recordFeedback({ source, kind } = {}) {
    try {
      const key = source === 'agent' ? K.feedbackAgent : K.feedbackUser;
      await b.batch([['hincrby', key, feedbackKindLabel(kind), 1]]);
    } catch (e) { warn('recordFeedback', e); }
  }

  // MCP matching telemetry (issue #182 «MCP» + #195 v2). Derived from the agent result. Best-effort.
  // v1: supplier no-match by УНП — rank the suppliers that fail to match most.
  // v2 (#195): from `result.matching` — мультиматчи по шагам (инструмент молча взял min(id) при >1
  //   совпадении) и несопоставленные артикулы (vendorCode не найден в каталоге), оба с cardinality-капом.
  async function recordMatching({ result } = {}) {
    try {
      const r = (result && typeof result === 'object') ? result : null;
      if (!r) return;

      // v1 — поставщик не найден по УНП. Cardinality-кап: НОВЫЙ УНП добавляем только под капом.
      if (r.error === 'supplier_not_found') {
        const unp = supplierKeyLabel(r.unp);
        if (unp) {
          const cur = await b.hgetall(K.matchingSuppliers);
          const field = (!(unp in (cur || {})) && Object.keys(cur || {}).length >= MATCHING_SUPPLIER_CAP)
            ? '__other__' : unp;
          await b.batch([['hincrby', K.matchingSuppliers, field, 1]]);
        }
      }

      // v2 (#195) — структурная телеметрия матчинга из result.matching.
      const m = (r.matching && typeof r.matching === 'object') ? r.matching : null;
      if (m) {
        // Мультиматчи по шагам (supplier/contract/product). Пин к известному набору + ДЕДУП в рамках
        // файла (find_product зовётся по позиции, шаг может прийти несколько раз): считаем «сколько
        // ДОКУМЕНТОВ имели мультиматч на шаге», а не сырые срабатывания — иначе счётчик неинтерпретируем.
        const steps = [...new Set((Array.isArray(m.multiMatches) ? m.multiMatches : [])
          .map(matchStepLabel).filter(Boolean))];
        if (steps.length) await b.batch(steps.map((s) => ['hincrby', K.matchingMulti, s, 1]));

        // Несопоставленные артикулы (vendorCode не найден). Уникализируем в рамках файла, кап на новые.
        const arts = [...new Set((Array.isArray(m.unmatchedArticles) ? m.unmatchedArticles : [])
          .map(articleKeyLabel).filter(Boolean))].slice(0, 50);
        if (arts.length) {
          const known = (await b.hgetall(K.matchingArticles)) || {};
          let n = Object.keys(known).length;
          const ops = [];
          for (const a of arts) {
            const isKnown = a in known;
            if (!isKnown && n >= MATCHING_ARTICLE_CAP) { ops.push(['hincrby', K.matchingArticles, '__other__', 1]); }
            else { ops.push(['hincrby', K.matchingArticles, a, 1]); if (!isKnown) n++; }
          }
          await b.batch(ops);
        }
      }
    } catch (e) { warn('recordMatching', e); }
  }

  async function snapshot() {
    const [totals, outcomes, formats, extract, daily, warnings, feedbackUser, feedbackAgent, matchingSuppliers, speed, matchingMulti, matchingArticles] = await Promise.all([
      b.hgetall(K.totals), b.hgetall(K.outcomes), b.hgetall(K.formats),
      b.hgetall(K.extract), b.hgetall(K.daily),
      b.hgetall(K.warnings), b.hgetall(K.feedbackUser), b.hgetall(K.feedbackAgent),
      b.hgetall(K.matchingSuppliers), b.hgetall(K.speed),
      b.hgetall(K.matchingMulti), b.hgetall(K.matchingArticles),
    ]);
    const t = numify(totals);
    const files = t.files || 0;
    const ok = t.ok || 0;
    const costRuns = t.cost_runs || 0;
    const agentRuns = t.agent_runs || 0;
    const processed = (t.files_done || 0) + (t.files_error || 0); // files that reached recordFile

    // Savings estimate (#75): manual time avoided × hourly rate, minus model cost.
    // Resolve the USD→BYN rate: live NB RB rate when a provider is wired (index.js), else the
    // static env fallback. Best-effort — a failing provider must not break the snapshot.
    let usdByn = econ.usdByn;
    let usdBynDate = null;
    let usdBynSource = 'env';
    if (getUsdByn) {
      try {
        const r = await getUsdByn();
        if (r && Number.isFinite(r.rate) && r.rate > 0) {
          usdByn = r.rate;
          usdBynDate = r.date ?? null;
          usdBynSource = r.source ?? 'nbrb';
        }
      } catch (e) { warn('usdByn provider', e); }
    }

    const positions = t.positions || 0;
    const positionsNoArticle = t.positions_no_article || 0;
    const savedByn = round2(((positions * econ.minutesPerPosition) / 60) * econ.hourlyRateByn);
    const modelCostByn = round2((t.cost_usd || 0) * usdByn);
    const lostNoArticleByn = round2(((positionsNoArticle * econ.minutesPerPosition) / 60) * econ.hourlyRateByn);

    return {
      generatedAt: new Date().toISOString(),
      economics: {
        enabled: econ.hourlyRateByn > 0,
        hourlyRateByn: econ.hourlyRateByn,
        minutesPerPosition: econ.minutesPerPosition,
        usdByn: round4(usdByn),
        usdBynDate,
        usdBynSource,
        positions,
        positionsNoArticle,
        // #264: доля позиций без артикула среди ВСЕХ распознанных по цене/кол-ву позиций
        // (сопоставленные `positions` + без артикула `positionsNoArticle`). Раньше знаменателем были
        // только matched-позиции, но после #258 позиции без артикула в них не входят — pct ушёл бы
        // вверх/некорректно. База (matched + без артикула) даёт устойчивый «процент потери».
        positionsNoArticlePct: (positions + positionsNoArticle)
          ? round1((positionsNoArticle / (positions + positionsNoArticle)) * 100)
          : 0,
        grossSavedByn: savedByn,
        modelCostByn,
        netSavedByn: round2(savedByn - modelCostByn),
        lostNoArticleByn,
      },
      totals: {
        uploads: t.uploads || 0,
        files,
        filesDone: t.files_done || 0,
        filesError: t.files_error || 0,
        ok,
        successRatePct: files ? round1((ok / files) * 100) : 0,
        costUsd: round4(t.cost_usd || 0),
        costRuns,
        avgCostUsd: costRuns ? round4((t.cost_usd || 0) / costRuns) : 0,
        agentRuns,
        avgAgentMs: agentRuns ? Math.round((t.agent_ms || 0) / agentRuns) : 0,
        // Среднее число ходов агента (#222): много ходов = поиск/итерации, мало = «думает».
        avgAgentTurns: agentRuns ? round1((t.agent_turns || 0) / agentRuns) : 0,
        // Среднее время агента в инструментах (#262 Шаг 2 ≈ ожидание REST к Bitrix24). Делится на
        // tool_runs (прогоны с известным toolMs), а не на agentRuns.
        toolRuns: t.tool_runs || 0,
        avgToolMs: (t.tool_runs || 0) ? Math.round((t.tool_ms || 0) / (t.tool_runs || 0)) : 0,
        avgFileMs: processed ? Math.round((t.file_ms || 0) / processed) : 0,
      },
      outcomes: toSortedArray(outcomes),
      formats: toSortedArray(formats),
      extract: toSortedArray(extract),
      // issue #207: распределение скорости разбора (fast/normal/slow) — агрегат для дашборда.
      speed: toSortedArray(speed),
      warnings: toSortedArray(warnings),
      feedback: { user: toSortedArray(feedbackUser), agent: toSortedArray(feedbackAgent) },
      matching: {
        suppliers: toSortedArray(matchingSuppliers).slice(0, 15),
        // issue #195: мультиматчи по шагам + топ несопоставленных артикулов.
        multi: toSortedArray(matchingMulti),
        articles: toSortedArray(matchingArticles).slice(0, 15),
      },
      daily: Object.entries(numify(daily))
        .map(([date, n]) => ({ date, files: n }))
        .sort((a, b2) => (a.date < b2.date ? -1 : 1)),
    };
  }

  async function ping() { return b.ping(); }

  return { recordUpload, recordFile, recordWarnings, recordFeedback, recordMatching, snapshot, ping };
}

// ── helpers ────────────────────────────────────────────────────────────────

function numify(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[k] = Number(v) || 0;
  return out;
}

/** Hash → [{ name, count }] sorted by count desc (for charts). */
function toSortedArray(obj) {
  return Object.entries(numify(obj))
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
const round4 = (x) => Math.round(x * 10000) / 10000;

/** Coerce to a finite number, else fall back to default d. */
function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

// ── storage backends ─────────────────────────────────────────────────────────
// Both expose: batch(ops: [cmd, key, field, n][]) and hgetall(key).

function redisBackend(url) {
  const client = new Redis(url, { lazyConnect: true, enableOfflineQueue: false, commandTimeout: 3000 });
  client.connect().catch((e) => console.error('[metrics] Redis connect error:', e.message));
  client.on('error', (e) => console.error('[metrics] Redis error:', e.message));
  return {
    async batch(ops) {
      const p = client.pipeline();
      for (const [cmd, ...args] of ops) p[cmd](...args);
      const results = await p.exec();
      // ioredis pipelines don't throw on a per-command error (e.g. WRONGTYPE) — surface it.
      if (Array.isArray(results)) {
        for (const [err] of results) { if (err) { warn('redis pipeline', err); break; } }
      }
    },
    async hgetall(key) { return client.hgetall(key); },
    async ping() { await client.ping(); },
  };
}

function memoryBackend() {
  const store = new Map(); // key -> Map(field -> number)
  const hash = (key) => {
    let m = store.get(key);
    if (!m) { m = new Map(); store.set(key, m); }
    return m;
  };
  return {
    async batch(ops) {
      for (const [, key, field, n] of ops) {
        const m = hash(key);
        m.set(field, (m.get(field) || 0) + Number(n));
      }
    },
    async hgetall(key) {
      const m = store.get(key);
      return m ? Object.fromEntries(m.entries()) : {};
    },
    async ping() { /* in-memory is always available */ },
  };
}
