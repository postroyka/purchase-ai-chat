#!/usr/bin/env bash
#
# Полуручной деплой REST-контроллеров procure-ai в коробку Bitrix24.
#
# Копирует ТОЛЬКО b24-controller/lib/controllers/procure*.php в
# <модуль shef.purchase>/lib/controllers/ на сервере по SSH.
#
# ⚠️ Модуль shef.purchase — живой код заказчика. Скрипт:
#    - выкладывает только наши файлы procure*.php;
#    - rsync БЕЗ --delete — чужие файлы не трогаются и не удаляются;
#    - по умолчанию dry-run; реальная выкладка только при APPLY=1.
#
# Настройки (env или scripts/.env.deploy):
#   B24_SSH_HOST          — хост сервера Bitrix24 (обязательно)
#   B24_SSH_USER          — пользователь SSH (обязательно)
#   B24_SSH_PORT          — порт SSH (по умолчанию 22)
#   B24_CONTROLLERS_PATH  — абсолютный путь до .../shef.purchase/lib/controllers
#                           (обязательно)
#
# Использование:
#   ./scripts/deploy-b24-controller.sh            # dry-run (ничего не меняет)
#   APPLY=1 ./scripts/deploy-b24-controller.sh    # реальная выкладка
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_DIR="$REPO_ROOT/b24-controller/lib/controllers"

# Подхватить scripts/.env.deploy, если есть.
if [ -f "$SCRIPT_DIR/.env.deploy" ]; then
  # shellcheck disable=SC1091
  set -a; . "$SCRIPT_DIR/.env.deploy"; set +a
fi

: "${B24_SSH_HOST:?B24_SSH_HOST не задан (env или scripts/.env.deploy)}"
: "${B24_SSH_USER:?B24_SSH_USER не задан}"
: "${B24_CONTROLLERS_PATH:?B24_CONTROLLERS_PATH не задан}"
B24_SSH_PORT="${B24_SSH_PORT:-22}"

if [ ! -d "$SRC_DIR" ]; then
  echo "Нет каталога с контроллерами: $SRC_DIR" >&2
  exit 1
fi

# Проверка: есть что выкладывать.
shopt -s nullglob
files=("$SRC_DIR"/procure*.php)
shopt -u nullglob
if [ "${#files[@]}" -eq 0 ]; then
  echo "Не найдено файлов procure*.php в $SRC_DIR" >&2
  exit 1
fi

echo "Файлы к выкладке:"
for f in "${files[@]}"; do echo "  - $(basename "$f")"; done
echo "Назначение: ${B24_SSH_USER}@${B24_SSH_HOST}:${B24_CONTROLLERS_PATH}/ (порт ${B24_SSH_PORT})"

# rsync: только procure*.php, БЕЗ --delete, с бэкапом перезаписываемого (на всякий).
RSYNC_FLAGS=(-avz --no-perms --omit-dir-times
  --include='procure*.php' --exclude='*'
  -e "ssh -p ${B24_SSH_PORT}")

if [ "${APPLY:-0}" = "1" ]; then
  echo ">>> APPLY=1 — реальная выкладка"
else
  echo ">>> dry-run (APPLY=1 для реальной выкладки)"
  RSYNC_FLAGS+=(--dry-run)
fi

rsync "${RSYNC_FLAGS[@]}" \
  "$SRC_DIR"/ \
  "${B24_SSH_USER}@${B24_SSH_HOST}:${B24_CONTROLLERS_PATH}/"

echo "Готово."
