#!/usr/bin/env bash
# CI-гейт политики дефолтов диагностики (#338). Если PR меняет ДЕФОЛТ флага диагностики в env-примерах
# (backend/.env.example / .env.prod.example), требуем сопутствующую правку docs/DIAGNOSTICS_POLICY.md —
# политика единый источник правды (см. CLAUDE.md → Workflow Rules; история ad-hoc-метаний #302→#314→#317).
#
# Точечный триггер (низкий риск ложных срабатываний): реагируем ТОЛЬКО на изменённые строки-присваивания
# `FLAG=value` в env-примерах (где живёт документированный дефолт), а не на любое упоминание флага в коде.
# Закомментированные строки `# FLAG=...` не считаются (начинаются с +#/-#).
set -euo pipefail

BASE_REF="${BASE_REF:-main}"
POLICY="docs/DIAGNOSTICS_POLICY.md"
FLAGS='SHOW_TIMINGS|HIDE_PERF_NOTE|TIMING_FAST_MS|TIMING_SLOW_MS|AGENT_FORCE_FEEDBACK'
# TODO: при создании нового env-примера с дефолтами диагностики — добавь его сюда, иначе гейт промолчит.
# Граница (намеренно): гейт НЕ ловит смену дефолта прямо в коде (backend/index.js `?? false`) — это
# остаётся на ревьюере (правило в CLAUDE.md). См. docs/DIAGNOSTICS_POLICY.md «Граница гейта».
ENV_FILES=(backend/.env.example .env.prod.example)
base="origin/${BASE_REF}"

flag_default_changed="$(git diff "${base}...HEAD" -- "${ENV_FILES[@]}" \
  | grep -E "^[+-](${FLAGS})=" || true)"

if [ -z "$flag_default_changed" ]; then
  echo "Дефолты флагов диагностики в env-примерах не менялись — гейт пропускает."
  exit 0
fi

policy_changed="$(git diff --name-only "${base}...HEAD" -- "$POLICY" || true)"
if [ -n "$policy_changed" ]; then
  echo "Дефолт флага диагностики изменён И ${POLICY} обновлён в этом PR — ок."
  exit 0
fi

echo "::error title=Дефолт диагностики без политики::Изменён env-дефолт флага диагностики, но ${POLICY} не тронут. По правилу #338 (CLAUDE.md → Workflow Rules) обновите политику в этом же PR или согласуйте с владельцем (CTO)."
echo "Затронутые строки в env-примерах:"
echo "$flag_default_changed" | sed 's/^/  /'
exit 1
