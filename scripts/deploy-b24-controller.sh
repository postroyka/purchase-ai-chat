#!/usr/bin/env bash
#
# Полуручной деплой REST-контроллеров procure-ai в коробку Bitrix24.
#
# Копирует наши файлы procure-ai в коробку shef.purchase по SSH:
#   - b24-controller/lib/controllers/procure*.php → <модуль>/lib/controllers/
#   - b24-controller/lib/config.php              → <модуль>/lib/
#
# ⚠️ Модуль shef.purchase — живой код заказчика. Скрипт:
#    - выкладывает только наши файлы (procure*.php + config.php);
#    - rsync БЕЗ --delete — чужие файлы не трогаются и не удаляются;
#    - по умолчанию dry-run (СИМУЛЯЦИЯ); реальная выкладка только при APPLY=1.
#
# Настройки (env или scripts/.env.deploy). Каждую можно задать и с префиксом
# PAI_ (procure-ai namespace) — напр. PAI_B24_SSH_HOST:
#   B24_SSH_HOST          — хост сервера Bitrix24 (обязательно)
#   B24_SSH_USER          — пользователь SSH (обязательно)
#   B24_SSH_PORT          — порт SSH (по умолчанию 22)
#   B24_CONTROLLERS_PATH  — абсолютный путь до .../shef.purchase/lib/controllers
#                           (обязательно)
#   B24_SSH_PASS          — пароль SSH (опц.; нужен пакет sshpass). Если не задан —
#                           используется SSH-ключ/agent. Пароль передаётся через
#                           SSHPASS (sshpass -e), не светится в списке процессов.
#   WEBHOOK_URL / PAI_WEBHOOK_URL — REST-вебхук для пост-деплой health-чека.
#                           При APPLY=1 обязателен (или явный SKIP_HEALTH=1).
#   SKIP_HEALTH=1         — осознанно пропустить health-чек при APPLY.
#
# Поведение:
#   - dry-run по умолчанию: rsync СРАВНИВАЕТ с сервером по SSH и печатает список
#     изменений (--itemize-changes: «>f…» — файл будет скопирован, «.f…» — без
#     изменений), но НА ДИСК СЕРВЕРА НИЧЕГО НЕ ПИШЕТ;
#   - APPLY=1: бэкап текущих файлов на сервере ВНЕ web-root (мгновенный откат) →
#     реальная выкладка → php -l config.php → пост-деплой read-only health-чек.
#
# Использование:
#   ./scripts/deploy-b24-controller.sh            # СИМУЛЯЦИЯ — на сервер не пишет
#   APPLY=1 ./scripts/deploy-b24-controller.sh    # реальная выкладка (+бэкап +health)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB_DIR="$REPO_ROOT/b24-controller/lib"
SRC_DIR="$LIB_DIR/controllers"

# Подхватить scripts/.env.deploy, если есть.
if [ -f "$SCRIPT_DIR/.env.deploy" ]; then
  # shellcheck disable=SC1091
  set -a; . "$SCRIPT_DIR/.env.deploy"; set +a
fi

# Алиасы с префиксом PAI_ (procure-ai namespace), если базовые имена не заданы.
B24_SSH_HOST="${B24_SSH_HOST:-${PAI_B24_SSH_HOST:-}}"
B24_SSH_USER="${B24_SSH_USER:-${PAI_B24_SSH_USER:-}}"
B24_SSH_PORT="${B24_SSH_PORT:-${PAI_B24_SSH_PORT:-}}"
B24_CONTROLLERS_PATH="${B24_CONTROLLERS_PATH:-${PAI_B24_CONTROLLERS_PATH:-}}"
B24_SSH_PASS="${B24_SSH_PASS:-${PAI_B24_SSH_PASS:-}}"

: "${B24_SSH_HOST:?B24_SSH_HOST/PAI_B24_SSH_HOST не задан (env или scripts/.env.deploy)}"
: "${B24_SSH_USER:?B24_SSH_USER/PAI_B24_SSH_USER не задан}"
: "${B24_CONTROLLERS_PATH:?B24_CONTROLLERS_PATH/PAI_B24_CONTROLLERS_PATH не задан}"
B24_SSH_PORT="${B24_SSH_PORT:-22}"

# Порт — только цифры (иначе подстановка в ssh -p может протащить лишние опции).
if ! [[ "$B24_SSH_PORT" =~ ^[0-9]+$ ]]; then
  echo "B24_SSH_PORT должен быть числом, получено: '$B24_SSH_PORT'" >&2
  exit 1
fi

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

# Путь до lib/ модуля = родитель lib/controllers (туда кладём config.php).
# Срезаем возможный trailing slash, иначе dirname вернёт сам каталог controllers.
B24_LIB_PATH="$(dirname "${B24_CONTROLLERS_PATH%/}")"

echo "Файлы к выкладке:"
for f in "${files[@]}"; do echo "  - controllers/$(basename "$f")"; done
[ -f "$LIB_DIR/config.php" ] && echo "  - config.php"
echo "Назначение: ${B24_SSH_USER}@${B24_SSH_HOST} (порт ${B24_SSH_PORT})"
echo "  controllers → ${B24_CONTROLLERS_PATH}/"
echo "  config.php  → ${B24_LIB_PATH}/"

# Транспорт SSH. BatchMode — не зависать на промптах; accept-new — не падать на
# первом подключении, но и не отключать проверку host key полностью.
# С паролем — через sshpass -e (пароль из env SSHPASS, не в argv).
SSH_OPTS="-p ${B24_SSH_PORT} -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20"
SSH_CMD="ssh ${SSH_OPTS}"
if [ -n "${B24_SSH_PASS:-}" ]; then
  if ! command -v sshpass >/dev/null 2>&1; then
    echo "Задан B24_SSH_PASS, но нет sshpass. Установите sshpass или используйте SSH-ключ." >&2
    exit 1
  fi
  export SSHPASS="$B24_SSH_PASS"
  # sshpass несовместим с BatchMode (он сам отвечает на промпт пароля).
  SSH_CMD="sshpass -e ssh -p ${B24_SSH_PORT} -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20"
fi

# Прямой вызов на сервере (намеренный word-split $SSH_CMD — в нём только токены
# без пробелов внутри значений).
remote() { $SSH_CMD "${B24_SSH_USER}@${B24_SSH_HOST}" "$1"; }

# Пост-деплой health: read-only проверка контроллеров. Семантика 3 уровней:
#   OK   — вернулся ожидаемый код/ключ (метод зарегистрирован, валидация/БД живы);
#   FAIL — ERROR_METHOD_NOT_FOUND или пустой ответ (метод не загружен / сервер лёг);
#   WARN — ответил иначе (метод жив, но напр. includeModules/БД дали свою ошибку) —
#          деплой НЕ валим, но просим проверить вручную.
# Негативные кейсы (код deal:010 и т.п.) НЕ создают данных — безопасно на боевой.
# Безопасность read-only держится на порядке валидации в контроллерах: supplierId<1
# и пустые поля отсекаются ДО любых CRM/БД side-effect (см. procure*.php).
postdeploy_health() {
  local hook="${1%/}" fail=0 resp
  _hc() {  # $1 метод, $2 тело, $3 ожидаемая подстрока (код ошибки или ключ)
    resp=$(curl -s -m 10 -X POST "${hook}/$1" -H 'Content-Type: application/json' -d "$2" 2>/dev/null || true)
    if [ -z "$resp" ]; then
      echo "    FAIL $1 → пустой ответ (сервер недоступен?)"; fail=1; return
    fi
    if printf '%s' "$resp" | grep -qF "\"$3\""; then
      echo "    OK   $1 → $3"; return
    fi
    if printf '%s' "$resp" | grep -qiF 'ERROR_METHOD_NOT_FOUND'; then
      echo "    FAIL $1 → ERROR_METHOD_NOT_FOUND (контроллер не зарегистрирован)"; fail=1; return
    fi
    # Ответил, но не тем — усекаем до 80 символов, чтобы не светить стек/пути в логе.
    echo "    WARN $1 → ждали \"$3\", иной ответ (контроллер жив, проверьте): $(printf '%s' "$resp" | tr -d '\n' | head -c 80)"
  }
  # Негативные — регистрация + ранняя валидация (supplierId=0 → deal:010 ДО Add):
  _hc "shef:purchase.api.procuresupplier.findbyunp"       '{"unp":""}'        'sup:010'
  _hc "shef:purchase.api.procurecontract.find"            '{"supplierId":0}'  'con:010'
  _hc "shef:purchase.api.procureproduct.findbyvendorcode" '{"vendorCode":""}' 'prd:010'
  _hc "shef:purchase.api.procuredeal.create"              '{"supplierId":0,"responsibleUserId":1,"fileName":"x","fileContent":"","processingLog":"","items":[{"name":"x","priceExclVat":1,"quantity":1}]}' 'deal:010'
  # Позитивный read-only — валидный несуществующий УНП проходит ВАЛИДАЦИЮ и идёт в
  # БД; ответ с ключом "result" подтверждает, что CRM-модуль и БД живы (не только
  # маршрут). Сделка/запись не создаётся.
  _hc "shef:purchase.api.procuresupplier.findbyunp"       '{"unp":"000000001"}' 'result'
  return $fail
}

# rsync БЕЗ --delete — чужие файлы не трогаются.
RSYNC_BASE=(-avz --no-perms --omit-dir-times -e "$SSH_CMD")

if [ "${APPLY:-0}" = "1" ]; then
  echo ">>> APPLY=1 — реальная выкладка"
  # Бэкап текущих целевых файлов ВНЕ web-root (~ = home SSH-юзера, www обычно ~/www),
  # чтобы старые .php не попадали в дерево сайта. Снимок ВСЕХ целевых файлов (а не
  # только изменённых) + список → полноценный откат. Ротация: 10 последних.
  BACKUP_REL=".procure-ai-deploy-backup/$(date +%Y%m%d-%H%M%S)"
  echo "    бэкап текущих файлов → ~/${BACKUP_REL}/ (на сервере, вне web-root)"
  remote "
    set -e
    mkdir -p '${BACKUP_REL}'
    cp -p '${B24_CONTROLLERS_PATH}'/procure*.php '${BACKUP_REL}/' 2>/dev/null || true
    cp -p '${B24_LIB_PATH}/config.php' '${BACKUP_REL}/' 2>/dev/null || true
    ls -1 '${B24_CONTROLLERS_PATH}'/procure*.php '${B24_LIB_PATH}/config.php' > '${BACKUP_REL}/.filelist' 2>/dev/null || true
    ls -1dt .procure-ai-deploy-backup/*/ 2>/dev/null | tail -n +11 | xargs -r rm -rf || true
  " || { echo "Не удалось создать бэкап на сервере — выкладка отменена." >&2; exit 1; }
else
  echo ">>> РЕЖИМ СИМУЛЯЦИИ (rsync --dry-run): идёт сравнение с сервером по SSH,"
  echo "    но НИ ОДИН файл не записывается. Для реальной выкладки: APPLY=1"
  RSYNC_BASE+=(--dry-run --itemize-changes)
fi

# 1) Контроллеры: только procure*.php в lib/controllers/.
rsync "${RSYNC_BASE[@]}" --include='procure*.php' --exclude='*' \
  "$SRC_DIR"/ \
  "${B24_SSH_USER}@${B24_SSH_HOST}:${B24_CONTROLLERS_PATH}/"

# 2) Конфиг: только config.php в lib/.
rsync "${RSYNC_BASE[@]}" --include='config.php' --exclude='*' \
  "$LIB_DIR"/ \
  "${B24_SSH_USER}@${B24_SSH_HOST}:${B24_LIB_PATH}/"

if [ "${APPLY:-0}" != "1" ]; then
  echo "Симуляция завершена — на сервер НИЧЕГО не записано (см. список изменений выше)."
  exit 0
fi

echo "Файлы выложены."

# Синтаксис config.php на сервере (ловит fatal до первого реального вызова).
# Не валим деплой, если php недоступен в неинтерактивном PATH — только предупреждаем.
if remote "command -v php >/dev/null 2>&1"; then
  if remote "php -l '${B24_LIB_PATH}/config.php'"; then
    echo "config.php — синтаксис OK."
  else
    echo "❌ config.php не проходит php -l. Откат: на сервере ~/${BACKUP_REL}/" >&2
    exit 1
  fi
else
  echo "(php -l пропущен — php не найден в неинтерактивном PATH сервера)"
fi

# Пост-деплой health-чек (read-only). Вебхук обязателен при APPLY (или SKIP_HEALTH=1).
HOOK="${WEBHOOK_URL:-${PAI_WEBHOOK_URL:-}}"
health_status="skipped"
if [ -n "$HOOK" ]; then
  echo ">>> Пост-деплой health-чек (read-only, сделки не создаются):"
  if postdeploy_health "$HOOK"; then
    echo "Health OK — контроллеры зарегистрированы и отвечают."
    health_status="ok"
  else
    echo "" >&2
    echo "❌ Health-чек не прошёл (см. FAIL выше)." >&2
    echo "   Откат: на сервере верните файлы из ~/${BACKUP_REL}/ , например:" >&2
    echo "     ${SSH_CMD} ${B24_SSH_USER}@${B24_SSH_HOST} \"cp -p ~/${BACKUP_REL}/procure*.php '${B24_CONTROLLERS_PATH}/' && cp -p ~/${BACKUP_REL}/config.php '${B24_LIB_PATH}/'\"" >&2
    exit 1
  fi
elif [ "${SKIP_HEALTH:-0}" = "1" ]; then
  echo "WARN: health-чек пропущен осознанно (SKIP_HEALTH=1)." >&2
else
  echo "WEBHOOK_URL/PAI_WEBHOOK_URL обязателен при APPLY=1 для пост-деплой проверки." >&2
  echo "Задайте вебхук или запустите с SKIP_HEALTH=1 для осознанного пропуска." >&2
  exit 1
fi

# Журнал деплоев (локальный, gitignored) — кто/когда/какой коммит/итог.
echo "$(date -u +%FT%TZ) APPLY host=${B24_SSH_HOST} git=$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo '?') user=$(whoami) backup=~/${BACKUP_REL} health=${health_status}" >> "$SCRIPT_DIR/deploy.log"

echo "Готово. Бэкап прежних версий: ~/${BACKUP_REL}/ (на сервере)."
