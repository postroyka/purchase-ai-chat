#!/usr/bin/env bash
# =====================================================================
#  Ручной деплой образов procure-ai в GHCR — БЕЗ GitHub Actions (путь B).
#  Собирает и пушит образы app + mcp в ghcr.io. На проде Watchtower
#  подхватит :latest (~5 мин), либо форсни сразу: `make prod-redeploy`.
#
#  Нужен Docker-демон + PAT со scope write:packages (read:packages).
#
#  Запуск:
#    GHCR_TOKEN=ghp_xxx bash scripts/deploy-images.sh
#    GHCR_TOKEN=ghp_xxx make deploy-images
#
#  Параметры (env):
#    GHCR_TOKEN  — PAT (write:packages). Если `docker login ghcr.io` уже сделан — можно опустить.
#    OWNER       — namespace образов в ghcr.io (по умолчанию: postroyka)
#    GHCR_USER   — логин для docker login (по умолчанию: $OWNER)
#    IMAGES      — какие собирать, через пробел: "app mcp" (по умолчанию оба)
#    PUSH        — 1 пушить (по умолчанию), 0 — только собрать (проверка)
#  Скопируйте весь вывод и пришлите при проблемах.
# =====================================================================
set -euo pipefail

OWNER="${OWNER:-postroyka}"
GHCR_USER="${GHCR_USER:-$OWNER}"
IMAGES="${IMAGES:-app mcp}"
PUSH="${PUSH:-1}"

# Корень репо = на уровень выше каталога скрипта, чтобы Docker-контекст был корнем репозитория
# (Dockerfile.app / Dockerfile.mcp ожидают context = ".").
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v docker >/dev/null 2>&1 || { echo "[FAIL] docker не найден в PATH"; exit 1; }
docker info >/dev/null 2>&1 || { echo "[FAIL] Docker-демон недоступен — запусти Docker и повтори"; exit 1; }

SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
echo "Деплой образов procure-ai → ghcr.io/$OWNER"
echo "Коммит: $SHA"
echo "Образы: $IMAGES | PUSH=$PUSH"
echo "---------------------------------------------"

# Логин в GHCR, если передан токен; иначе считаем, что docker login уже выполнен.
if [ -n "${GHCR_TOKEN:-}" ]; then
  echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
fi

for name in $IMAGES; do
  case "$name" in
    app) dockerfile="Dockerfile.app" ;;
    mcp) dockerfile="Dockerfile.mcp" ;;
    *) echo "[FAIL] неизвестный образ '$name' (ожидается app|mcp)"; exit 1 ;;
  esac
  repo="ghcr.io/$OWNER/procure-ai-$name"
  # latest — для Watchtower; sha-<commit> — для отката на конкретную сборку (как в deploy.yml).
  echo ">>> build $repo (:latest, :sha-$SHA) ← $dockerfile"
  docker build -f "$dockerfile" -t "$repo:latest" -t "$repo:sha-$SHA" .
  if [ "$PUSH" = "1" ]; then
    echo ">>> push $repo:latest";   docker push "$repo:latest"
    echo ">>> push $repo:sha-$SHA"; docker push "$repo:sha-$SHA"
  fi
done

echo "---------------------------------------------"
if [ "$PUSH" = "1" ]; then
  echo "[OK] образы собраны и запушены в GHCR."
  echo "Накат на сервере: make prod-redeploy   (или подождать Watchtower ~5 мин)"
else
  echo "[OK] образы собраны (PUSH=0 — без пуша)."
fi
