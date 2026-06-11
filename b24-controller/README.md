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

Любой `Engine\Controller` в этом namespace автоматически доступен по REST как
`shef.purchase.api.<controller>.<action>`. Отдельный модуль/инсталлятор не нужен.

## Контроллеры

> Bitrix24 REST приводит имена методов к нижнему регистру. В запросах и в коде
> используется lowercase; camelCase-имена экшенов в PHP — это только имена методов класса.

| REST-метод (lowercase) | PHP-экшен | Файл | Статус |
|---|---|---|---|
| `shef.purchase.api.procuresupplier.findbyunp` | `findByUnpAction` | `procuresupplier.php` | ✅ реализован (B1) |
| `shef.purchase.api.procureproduct.findbyvendorcode` | `findByVendorCodeAction` | `procureproduct.php` | ✅ реализован (B4–B5) |
| `shef.purchase.api.procurecontract.find` | `findAction` | `procurecontract.php` | ✅ реализован (B3a–B3e) |
| `shef.purchase.api.procuredeal.create` | `createAction` | `procuredeal.php` | ✅ реализован (B6–B8) |

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
`B24_SSH_HOST`, `B24_SSH_USER`, `B24_SSH_PORT`, `B24_CONTROLLERS_PATH`.

Скрипт ([`scripts/deploy-b24-controller.sh`](../scripts/deploy-b24-controller.sh)):
- копирует **только** `procure*.php` в `lib/controllers/` и `config.php` в `lib/`;
- `rsync` **без** `--delete` — чужие файлы модуля `shef.purchase` не затрагиваются;
- по умолчанию делает dry-run; реальная выкладка — `make deploy-b24 APPLY=1`.

Папка исключена из Docker-образов (`.dockerignore`).

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
