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
import { scoreResult } from './score.js';

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

  const passed = results.filter((r) => r.pass).length;
  console.log(`=== EVAL: ${passed}/${results.length} фикстур прошло ===`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
