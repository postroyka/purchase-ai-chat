#!/usr/bin/env bash
# =====================================================================
#  UI-смоук procure-ai: быстрая проверка фронта без полной сборки.
#  Гоняет ESLint + TypeScript (nuxt typecheck) и пару grep-инвариантов.
#  Цель — одной командой проверить ветку дашборда (например, перед PR).
#
#  Запуск:  bash scripts/ui-smoke.sh      (или: make ui-smoke)
#  Любой провал → exit 1. Скопируйте весь вывод и пришлите при проблемах.
# =====================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/ui"

fail=0
step() { printf '\n=== %s ===\n' "$1"; }

step "ESLint"
pnpm exec eslint . && echo "[OK] eslint" || { echo "[FAIL] eslint"; fail=1; }

step "TypeScript (nuxt typecheck)"
pnpm typecheck && echo "[OK] typecheck" || { echo "[FAIL] typecheck"; fail=1; }

step "Инварианты"
# Удалённый UserMenu не должен ИСПОЛЬЗОВАТЬСЯ (импорт/тег/путь); упоминание в комментарии — ок.
if grep -rnE "import[^\"']*UserMenu|<UserMenu|components/UserMenu" app >/dev/null 2>&1; then
  echo "[FAIL] остались ссылки на компонент UserMenu"; fail=1
else
  echo "[OK] компонент UserMenu не используется"
fi

echo ""
if [ "$fail" = "0" ]; then echo "[OK] UI-смоук пройден"; else echo "[FAIL] UI-смоук со сбоями"; fi
exit "$fail"
