# b24-controller

REST-контроллеры для procure-ai, размещаемые внутри **существующего** модуля
`shef.purchase` коробки Bitrix24 (`b24.postroyka.by`).

> ⚠️ **Модуль `shef.purchase` — живой код заказчика.** Мы добавляем ТОЛЬКО
> новые файлы `lib/controllers/procure*.php`. Ничего существующего не трогаем,
> ничего не удаляем. Деплой никогда не перезаписывает чужие файлы.

## Как это работает

Модуль `shef.purchase` включает REST-интеграцию через `.settings.php`:

```php
'controllers' => ['value' => [
    'namespaces' => ['\\Shef\\Purchase\\Controllers' => 'api'],
    'restIntegration' => ['enabled' => true],
]]
```

Любой `Engine\Controller` в этом namespace автоматически доступен по REST.

> **Важно: формат имени метода для кастомного модуля**
> Bitrix24 использует двоеточие как разделитель между именем модуля и prefix-scope:
> `shef:purchase.api.<controller>.<action>`
> (не точку, как у стандартных модулей). Это специфика коробочных кастомных модулей.

Отдельный модуль/инсталлятор не нужен.

## Контроллеры

> Bitrix24 REST приводит имена методов к нижнему регистру. В запросах и в коде
> используется lowercase; camelCase-имена экшенов в PHP — это только имена методов класса.

| REST-метод (lowercase) | PHP-экшен | Файл | Статус |
|---|---|---|---|
| `shef:purchase.api.procuresupplier.findbyunp` | `findByUnpAction` | `procuresupplier.php` | ✅ реализован (B1) |
| `shef:purchase.api.procureproduct.findbyvendorcode` | `findByVendorCodeAction` | `procureproduct.php` | ✅ реализован (B4–B5) |
| `shef:purchase.api.procurecontract.find` | `findAction` | `procurecontract.php` | ✅ реализован (B3a–B3e) |
| `shef:purchase.api.procuredeal.create` | `createAction` | `procuredeal.php` | ✅ реализован (B6–B8) |

Подробности структур Б24 — в [`IMPLEMENTATION_NOTES.md`](./IMPLEMENTATION_NOTES.md).

## Структура (= путь на сервере)

```
b24-controller/
└── lib/
    ├── config.php              ← Config: централизованные параметры модуля
    └── controllers/
        ├── procuresupplier.php
        ├── procureproduct.php
        ├── procurecontract.php
        └── procuredeal.php
```

На сервере: контроллеры → `…/bitrix/modules/shef.purchase/lib/controllers/`,
`config.php` → `…/bitrix/modules/shef.purchase/lib/`.

## Вебхук

MCP-сервер вызывает методы через стандартный входящий вебхук Bitrix24
(`NUXT_BITRIX24_WEBHOOK_URL`).

При создании вебхука в Б24 → **Настройки → REST → Входящие вебхуки** нужно включить скоуп:
- **`shef.purchase`** — под этим именем модуль публикует REST через `restIntegration`
- **`crm`** — для стандартных CRM-методов (создание сделки, компании)

> Имя скоупа совпадает с именем модуля. Если метод возвращает `QUERY_AUTH_ERROR` —
> проверьте, что оба скоупа включены в настройках вебхука.

## Деплой — полуручной

Деплой **не автоматический** (на push не запускается). Выкладка по команде:

```bash
make deploy-b24            # rsync procure*.php → сервер по SSH
```

Параметры берутся из окружения (или `scripts/.env.deploy`, см. `scripts/.env.deploy.example`):
`B24_SSH_HOST`, `B24_SSH_USER`, `B24_SSH_PORT`, `B24_CONTROLLERS_PATH`. Каждый можно
задать и с префиксом `PAI_` (procure-ai namespace). Парольная аутентификация —
`B24_SSH_PASS` (нужен пакет `sshpass`); иначе используется SSH-ключ/agent.

Скрипт ([`scripts/deploy-b24-controller.sh`](../scripts/deploy-b24-controller.sh)):
- копирует **только** `procure*.php` в `lib/controllers/` и `config.php` в `lib/`;
- `rsync` **без** `--delete` — чужие файлы модуля `shef.purchase` не затрагиваются;
- **dry-run по умолчанию**: сравнивает с сервером по SSH и печатает список изменений,
  но **на диск сервера ничего не пишет** (показать реальную дельту, ничего не меняя);
- **`APPLY=1`** — бэкап текущих файлов на сервере **вне web-root**
  (`~/.procure-ai-deploy-backup/<дата>/`, ротация 10 последних → мгновенный откат) →
  выкладка → `php -l` config.php **на сервере** → **пост-деплой health-чек** (read-only:
  контроллеры зарегистрированы + БД жива; сделки не создаются). Вебхук **обязателен**
  при `APPLY` (`WEBHOOK_URL`/`PAI_WEBHOOK_URL`) либо явный `SKIP_HEALTH=1`. Каждый
  `APPLY` дописывает строку в `scripts/deploy.log` (gitignored): дата, env, git-коммит,
  путь бэкапа, статус health.

Папка исключена из Docker-образов (`.dockerignore`).

### Рекомендуемый порядок: staging → prod

Две коробки: **`tstb24.postroyka.by`** (тест/dev) и **`b24.postroyka.by`** (боевая).
Безопасный цикл выкатки:

1. Выложить и проверить на **tstb24** (`.env.deploy` → tstb24): `make deploy-b24 APPLY=1`
   (health-чек пройдёт автоматически), затем полный `bash scripts/smoke-test-b24.sh`
   (включая создание сделок 4a/4b — это тестовая коробка).
2. Только после зелёного — выложить на **b24** (`.env.deploy` → b24): `make deploy-b24 APPLY=1`.
   На боевой полный smoke с созданием сделок не гоняем — достаточно автоматического
   read-only health-чека.

**Откат** (точный путь бэкапа печатает скрипт при деплое). Зайдите на сервер и
скопируйте сохранённые версии обратно — `~` раскроется на сервере:

```bash
ssh bitrix@<host>
DST=/home/bitrix/www/bitrix/modules/shef.purchase/lib
cp -p ~/.procure-ai-deploy-backup/<дата>/procure*.php "$DST"/controllers/
cp -p ~/.procure-ai-deploy-backup/<дата>/config.php   "$DST"/
```

> Бэкап — снимок файлов, существовавших ДО деплоя (их список в `.filelist`).
> Перезаписанные файлы откат вернёт; **файлы, добавленные этим деплоем** (новые
> контроллеры) откат не удаляет — при необходимости удалите их вручную.

### Предусловия первого деплоя

Перед первым `make deploy-b24 APPLY=1` убедитесь:

1. **SSH-ключ** добавлен для пользователя `B24_SSH_USER` на сервере Б24.
2. **Целевая директория существует** на сервере:
   ```
   ssh user@host "ls /home/bitrix/www/bitrix/modules/shef.purchase/lib/controllers/"
   ```
   rsync не создаёт вложенные директории — если путь не существует, выполните `mkdir -p` вручную.
3. **Права на запись** у `B24_SSH_USER` в целевой директории.
4. **`scripts/.env.deploy`** заполнен по примеру `scripts/.env.deploy.example`.
5. **Host-key зафиксирован.** Скрипт использует `StrictHostKeyChecking=accept-new`;
   чтобы исключить MitM при первом подключении, добавьте ключ сервера заранее:
   ```
   ssh-keyscan -p <порт> <host> >> ~/.ssh/known_hosts
   ```

### Автоматический деплой (CI)

Workflow [`.github/workflows/deploy-b24.yml`](../.github/workflows/deploy-b24.yml)
выкладывает контроллеры на **одну** коробку (задаётся repository-секретами):

- **push в `main`** → после зелёного CI, если менялись `lib/controllers/procure*.php`
  или `lib/config.php`, деплой выполняется автоматически (бэкап + `php -l` + read-only
  health + **авто-rollback при провале** — в скрипте). Деплоится коммит, на котором
  отработал CI.
- **`workflow_dispatch`** (Actions → Deploy b24-controller → Run) → ручной запуск;
  можно включить **dry_run** (симуляция, без записи на сервер).

Ручной `make deploy-b24 APPLY=1` остаётся рабочим (отладка, ad-hoc).

> ⚠️ **Сетевой доступ.** GitHub-hosted раннеры ходят с динамических облачных IP
> (диапазоны — `https://api.github.com/meta`, поле `actions`). Если SSH-порт коробки
> закрыт файрволом/по IP — деплой не дойдёт. Тогда нужен **self-hosted runner** в сети
> заказчика: в `deploy-b24.yml` замените `runs-on: ubuntu-latest` на ваш label.

**Настройка** (Settings → Secrets and variables → Actions → **Repository secrets**):
- `B24_SSH_HOST`, `B24_SSH_USER`, `B24_SSH_PORT`, `B24_CONTROLLERS_PATH`,
  `WEBHOOK_URL` (вебхук ТОЙ ЖЕ коробки), и **аутентификация SSH**: `B24_SSH_PASS`
  (пароль) *или* deploy-key на хосте.
- Опц., рекомендуется: `B24_SSH_HOST_KEY` — строка `known_hosts` сервера (пиннинг
  host-key; получить: `ssh-keyscan -p <порт> <host>`).

> Это упрощённый вариант — **одна** цель, repo-secrets, без аппрува. Разделение на
> 2 окружения (staging + production по approval, изоляция секретов) — **issue #112**.

> Полный smoke с созданием сделок в CI не гоняется — авто-проверка ограничена
> read-only health-чеком. Полный smoke — вручную.
>
> ⚠️ Деплой PHP ≠ готовая к smoke среда: MCP-образ обновляется отдельно (Watchtower,
> ~5 мин); при контрактных изменениях MCP↔PHP учитывайте окно рассинхрона.

### Деплой при изменении контракта MCP ↔ PHP

⚠️ **Контроллеры (`b24-controller`) и MCP-инструменты деплоятся по-разному:**
PHP — полуручным `make deploy-b24 APPLY=1`, а Docker-образ MCP — автоматически
через Watchtower после мержа в `main`. Из-за этого при изменении контракта
(новые параметры, новые поля ответа, переименование action) есть риск
«тихого» рассинхрона версий:

- MCP обновился раньше PHP → инструмент шлёт новые параметры, старый контроллер их игнорирует / падает;
- PHP обновился раньше MCP → новые поля ответа никто не читает.

**Порядок действий при изменении контракта** (соблюдать строго):

1. Изменить PHP-контроллер (`procure*.php`) + при необходимости `config.php`.
2. Изменить MCP-инструмент (`mcp-overlay/server/mcp/tools/...`) + его тесты (`mcp-overlay/tests/`).
3. **Сначала задеплоить PHP** на Битрикс: `make deploy-b24 APPLY=1`
   (сначала dry-run без `APPLY` — проверить список файлов).
4. **Затем обновить MCP** (мерж в `main` → Watchtower подтянет образ; либо вручную
   на сервере через корневой prod-compose:
   `docker compose -f docker-compose.prod.yml pull mcp && docker compose -f docker-compose.prod.yml up -d mcp`).
   *(Не путать с upstream-файлами `mcp/docker-compose.*.yml` — для прод-деплоя
   используется корневой `docker-compose.prod.yml`, где описан сервис `mcp`.)*
5. Проверить smoke-тестом против живого вебхука (нужен `WEBHOOK_URL`):
   - Linux: `WEBHOOK_URL=https://your-b24/rest/1/TOKEN/ bash scripts/smoke-test-b24.sh`
   - Windows: `scripts/smoke-test-b24.ps1 -WebhookUrl https://your-b24/rest/1/TOKEN/`

> Правило большого пальца: **PHP-сторона выкатывается первой** — она должна
> уметь принять и старый, и новый формат запроса MCP. Тогда любой порядок
> обновления контейнера безопасен.

При открытии PR, меняющего `b24-controller/lib/controllers/procure*.php` или
`config.php`, CI выводит напоминание задеплоить PHP вручную после мержа
(job **«b24 deploy reminder»** в `.github/workflows/ci.yml`).

## Опции модуля (настройки)

Часть параметров переопределяется через настройки модуля `shef.purchase`,
чтобы не хардкодить ID конкретной коробки. Все они читаются через единую точку —
класс [`\Shef\Purchase\Config`](./lib/config.php) (`lib/config.php`), а не через
прямые `Option::get` в контроллерах:

| Опция | Default | Геттер `Config::` | Назначение |
|---|---|---|---|
| `B24_DEAL_CATEGORY_ID` | `1` | `getDealCategoryId()` | Воронка сделок («Закупки») |
| `B24_DEAL_DEFAULT_STAGE_ID` | `C1:NEW` | `getDealDefaultStageId()` | Стадия новой сделки |
| `B24_CATALOG_IBLOCK_ID` | `15` | `getCatalogIblockId()` | Инфоблок каталога товаров |
| `B24_UNIT_OKEI_SHT` | `796` | `getUnitOkeiSht()` | ОКЕИ-код единицы «штука» |

## Тестирование

PHP-контроллеры тестируются **только вручную на dev/боевой коробке** Bitrix24 —
юнит-тестов в репозитории нет (требуется живое ядро Б24 с модулями `crm`,
`iblock`, `shef.iblock`). Покрытие тестами есть у вызывающей стороны —
MCP-инструменты `mcp-overlay/tests/unit/tools/deals/`.
