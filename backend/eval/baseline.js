#!/usr/bin/env node
// Baseline-режим eval: гоняет РЕАЛЬНОГО агента по счетам, у которых ещё НЕТ эталона, и
// сохраняет ЧЕРНОВИК <name>.expected.json из того, что агент извлёк. Дальше человек сверяет
// черновик с документом и правит его в настоящий эталон — так структуру не пишут с нуля.
//
// ⚠️ Как и run.js, требует живого окружения агента: claude CLI + ключ модели (ANTHROPIC_*/
//    провайдер) + доступный MCP + извлечение текста (pdftotext/OCR). Это СЕРВЕРНАЯ команда.
//
// Запуск:  make eval-baseline
// Переменные: EVAL_SAMPLES_DIR (где лежат счета), EVAL_RESPONSIBLE_ID,
//             EVAL_OVERWRITE=1 (перезаписать уже существующие черновики).

import { readdir, writeFile, access } from 'node:fs/promises';
import { join, dirname, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from '../agent-runner.js';
import { draftSpecFromResult } from './score.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = process.env.EVAL_SAMPLES_DIR ?? join(HERE, '..', '..', 'scripts', 'samples');
const RESPONSIBLE_ID = process.env.EVAL_RESPONSIBLE_ID ?? '1';
const OVERWRITE = process.env.EVAL_OVERWRITE === '1';
// Расширения, которые умеет читать пайплайн (backend/extract-text.js).
const DOC_EXT = new Set(['.pdf', '.xlsx', '.xls', '.docx', '.png', '.jpg', '.jpeg']);

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function main() {
  const entries = await readdir(SAMPLES_DIR);
  const invoices = entries.filter((f) => DOC_EXT.has(extname(f).toLowerCase())).sort();
  if (invoices.length === 0) {
    console.error(`Нет документов (${[...DOC_EXT].join('/')}) в ${SAMPLES_DIR}`);
    process.exit(2);
  }

  console.log(`Baseline: ${invoices.length} документ(ов) из ${SAMPLES_DIR}\n`);
  let wrote = 0;
  let skipped = 0;
  for (const file of invoices) {
    const stem = basename(file, extname(file));
    const specPath = join(SAMPLES_DIR, `${stem}.expected.json`);
    if (await exists(specPath) && !OVERWRITE) {
      console.log(`⏭  ${file} — эталон уже есть (EVAL_OVERWRITE=1, чтобы перезаписать черновиком)`);
      skipped += 1;
      continue;
    }

    console.log(`▶ ${file}`);
    let result;
    try {
      result = await runAgent(join(SAMPLES_DIR, file), RESPONSIBLE_ID, {});
    } catch (e) {
      console.log(`   ⚠️  прогон упал: ${e?.message ?? e}\n`);
      continue;
    }
    // Показываем, что агент извлёк — уже глазами видно, насколько точно.
    console.log(`   извлечено: ${JSON.stringify(result)}`);
    const draft = draftSpecFromResult(file, result);
    await writeFile(specPath, JSON.stringify(draft, null, 2) + '\n', 'utf8');
    console.log(`   📝 черновик → ${stem}.expected.json  (ПРОВЕРЬ и поправь!)\n`);
    wrote += 1;
  }

  console.log(`=== BASELINE: записано ${wrote} черновиков, пропущено ${skipped} ===`);
  if (wrote > 0) {
    console.log('Дальше: открой каждый *.expected.json, сверь с документом, поправь поля,');
    console.log('убери "draft": true и (для НДС) впиши priceInclVatHint. Затем — make eval.');
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
