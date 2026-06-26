#!/usr/bin/env bash
# Повторяет CI-джоб «Test mcp-overlay deals tools» (.github/workflows/ci.yml) локально (#337).
#
# Зачем: локальный `pnpm test` в mcp/ НЕ видит overlay-тесты — CI копирует overlay в mcp/ и
# гоняет vitest tests/overlay отдельным джобом. Из-за этого регресс (напр. #324: contractId стал
# optional) проходил мимо локальной проверки и краснил main. Эта цель ловит такое ДО мержа.
#
# Делает то же, что CI: копирует overlay deals/utils/tests в mcp/, typecheck, vitest, затем чистит.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/mcp"

cleanup() {
  rm -rf server/mcp/tools/deals server/utils/rest-timing.ts server/utils/rest-timing.test.ts tests/overlay 2>/dev/null || true
}
# Чистим и до (на случай прерванного прошлого прогона), и после (trap).
cleanup
trap cleanup EXIT

# Guard'ы как в CI: overlay-файлы не должны существовать в upstream mcp (иначе конфликт оверлея).
[ ! -e server/mcp/tools/deals ] || { echo "ERROR: deals уже есть в upstream mcp — конфликт оверлея"; exit 1; }
[ ! -e server/utils/rest-timing.ts ] || { echo "ERROR: rest-timing.ts уже есть в upstream utils — конфликт оверлея"; exit 1; }

cp -r ../mcp-overlay/server/mcp/tools/deals server/mcp/tools/deals
cp -r ../mcp-overlay/server/utils/. server/utils/

echo "==> typecheck overlay против vendored mcp"
pnpm typecheck

cp -r ../mcp-overlay/tests/unit tests/overlay
echo "==> vitest run tests/overlay"
pnpm exec vitest run tests/overlay
