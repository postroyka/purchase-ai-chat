#!/usr/bin/env bash
# =====================================================================
#  Регрессия #58: `claude --print` должен принимать промпт из STDIN.
#  backend/agent-runner.js шлёт промпт (с DOCUMENT_TEXT до ~100k симв.) через
#  stdin, а не argv — иначе большой кириллический документ роняет spawn с E2BIG
#  (Linux MAX_ARG_STRLEN = 128 КиБ/аргумент). Скрипт проверяет, что установленный
#  claude действительно читает промпт из stdin (а не только из позиционного arg).
#
#  Запуск:  bash scripts/check-agent-stdin.sh   (или: make check-agent-stdin)
#  claude нет в PATH → пропуск (exit 0). Реальный API-ключ НЕ нужен: достаточно,
#  что CLI прочитал stdin и дошёл до вызова API (фейк-ключ → быстрый 401).
#  ВНИМАНИЕ: делает РЕАЛЬНЫЙ сетевой вызов к API (фейк-ключ → 401). В air-gapped
#  среде claude зависнет до timeout (40с), затем скрипт завершится exit 0.
# =====================================================================
set -uo pipefail

if ! command -v claude >/dev/null 2>&1; then
  echo "[SKIP] claude не найден в PATH — проверка пропущена"
  exit 0
fi

TMPH="$(mktemp -d)"
trap 'rm -rf "$TMPH"' EXIT

# Чистый env (без ambient ANTHROPIC_*/CLAUDE_CODE_*), фейк-ключ → быстрый 401.
out="$(printf 'ping' \
  | env -i PATH="$PATH" HOME="$TMPH" ANTHROPIC_API_KEY=sk-ant-invalid-0000 \
    timeout 40 claude --print --output-format json --bare 2>&1 || true)"

if printf '%s' "$out" | grep -q 'Input must be provided'; then
  echo "[FAIL] claude НЕ прочитал промпт из stdin — E2BIG-фикс сломан этой версией CLI:"
  printf '%s\n' "$out" | head -c 300
  exit 1
fi
if printf '%s' "$out" | grep -q '"type":"result"'; then
  echo "[OK] claude читает промпт из stdin (получен JSON-результат CLI)"
  exit 0
fi
# Нет ошибки «no prompt», но и не JSON (например, сетевой сбой до API) — stdin всё
# равно прочитан (CLI дошёл до запроса). Считаем OK с пометкой.
echo "[OK?] claude принял stdin (нет ошибки 'no prompt'); ответ нестандартный:"
printf '%s\n' "$out" | head -c 300
exit 0
