#!/usr/bin/env node
// Eval-runner: гоняет РЕАЛЬНЫЙ пайплайн агента по фикстурам и сверяет вывод с эталоном.
//
// ⚠️ Требует рабочего окружения агента: claude CLI + ключ модели (ANTHROPIC_*/провайдер),
//    доступный MCP-сервер и извлечение текста (pdftotext/OCR). Предназначен для СЕРВЕРА,
//    НЕ для CI (каждая фикстура = платный вызов модели). Чистая логика скоринга покрыта
//    юнит-тестами в backend/tests/eval-score.test.js.
//
// Фикстуры: пары <name>.pdf + <name>.expected.json в scripts/samples/ (или EVAL_SAMPLES_DIR).
// Формат <name>.expected.json — см. backend/eval/README.md.
//
// Запуск:  make eval        (или: node backend/eval/run.js)
// Переменные: EVAL_SAMPLES_DIR, EVAL_RESPONSIBLE_ID, AGENT_TIMEOUT_MS, MCP_SERVER_URL, …

import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from '../agent-runner.js';
import { scoreResult, summarize } from './score.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = process.env.EVAL_SAMPLES_DIR ?? join(HERE, '..', '..', 'scripts', 'samples');
const RESPONSIBLE_ID = process.env.EVAL_RESPONSIBLE_ID ?? '1';

async function main() {
  const entries = await readdir(SAMPLES_DIR);
  const specFiles = entries.filter((f) => f.endsWith('.expected.json')).sort();
  if (specFiles.length === 0) {
    console.error(`Нет *.expected.json в ${SAMPLES_DIR}`);
    process.exit(2);
  }

  console.log(`Eval-набор: ${specFiles.length} фикстур из ${SAMPLES_DIR}\n`);
  const results = [];

  for (const specFile of specFiles) {
    const expected = JSON.parse(await readFile(join(SAMPLES_DIR, specFile), 'utf8'));
    const fixturePath = join(SAMPLES_DIR, expected.fixture);
    const want = `${expected.expect}${expected.error ? ' ' + expected.error : ''}`;
    console.log(`▶ ${expected.fixture}  (ожидаем: ${want})`);
    // Незаправленный baseline-черновик: сравнение агента с его же выводом не показательно.
    if (expected.draft) console.log('   ⚠️  это ЧЕРНОВИК (baseline) — сверь и поправь эталон, иначе результат бессмысленный');

    let actual;
    try {
      actual = await runAgent(fixturePath, RESPONSIBLE_ID, {});
    } catch (e) {
      // Падение прогона ≠ результат агента: помечаем отдельным кодом, чтобы скорер дал FAIL.
      actual = { error: 'eval_run_failed', message: e?.message ?? String(e) };
    }

    const score = scoreResult(actual, expected);
    for (const c of score.checks) {
      console.log(`   ${c.ok ? '✅' : '❌'} ${c.name}${c.ok ? '' : ` — ${c.detail}`}`);
    }
    console.log(`   → ${score.pass ? 'PASS' : 'FAIL'}\n`);
    results.push(score);
  }

  // Агрегатная метрика (#93): доля совпавших полей + частота НДС-ошибки ×0.8 (баг #58).
  const sum = summarize(results);
  console.log(`=== EVAL: ${sum.fixtures.passed}/${sum.fixtures.total} фикстур прошло ===`);
  console.log(`Поля: ${sum.checks.passed}/${sum.checks.total} совпало с эталоном`
    + (sum.checks.pct != null ? ` (${sum.checks.pct}%)` : ''));
  if (sum.vat.total > 0) {
    console.log(`Направление НДС: ÷1.2 — ${sum.vat.divideBy1_2}, ×0.8 — ${sum.vat.multiplyBy0_8}`
      + (sum.vat.errorPct != null ? `  (ошибок ×0.8: ${sum.vat.errorPct}%)` : ''));
  }
  process.exit(sum.fixtures.passed === sum.fixtures.total ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
