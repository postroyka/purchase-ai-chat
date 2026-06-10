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

| REST-метод | Класс / файл | Статус |
|---|---|---|
| `shef.purchase.api.procuresupplier.findByUnp` | `ProcureSupplier` | ✅ реализован (B1) |
| `shef.purchase.api.procureproduct.findByVendorCode` | `ProcureProduct` | ✅ реализован (B4–B5, точное совпадение) |
| `shef.purchase.api.procurecontract.find` | `ProcureContract` | ✅ реализован (B3a–B3e) |
| `shef.purchase.api.procuredeal.create` | `ProcureDeal` | ✅ реализован (B6–B8) |

Подробности структур Б24 — в [`IMPLEMENTATION_NOTES.md`](./IMPLEMENTATION_NOTES.md).

## Структура (= путь на сервере)

```
b24-controller/
└── lib/
    └── controllers/
        ├── procuresupplier.php
        ├── procureproduct.php
        ├── procurecontract.php
        └── procuredeal.php
```

На сервере кладётся в: `…/bitrix/modules/shef.purchase/lib/controllers/`

## Вебхук

MCP-сервер вызывает методы через стандартный входящий вебхук Bitrix24
(`NUXT_BITRIX24_WEBHOOK_URL`). Вебхуку нужен скоуп, под которым модуль
`shef.purchase` публикует REST (подтвердить имя скоупа при создании вебхука).

## Деплой — полуручной

Деплой **не автоматический** (на push не запускается). Выкладка по команде:

```bash
make deploy-b24            # rsync procure*.php → сервер по SSH
```

Параметры берутся из окружения (или `scripts/.env.deploy`, см. `scripts/.env.deploy.example`):
`B24_SSH_HOST`, `B24_SSH_USER`, `B24_SSH_PORT`, `B24_CONTROLLERS_PATH`.

Скрипт ([`scripts/deploy-b24-controller.sh`](../scripts/deploy-b24-controller.sh)):
- копирует **только** `b24-controller/lib/controllers/procure*.php`;
- `rsync` **без** `--delete` — чужие файлы модуля `shef.purchase` не затрагиваются;
- по умолчанию делает dry-run; реальная выкладка — `make deploy-b24 APPLY=1`.

Папка исключена из Docker-образов (`.dockerignore`).

## Опции модуля (настройки)

Часть параметров переопределяется через настройки модуля `shef.purchase`
(`Option::get('shef.purchase', ...)`), чтобы не хардкодить ID конкретной коробки:

| Опция | Default | Назначение |
|---|---|---|
| `B24_DEAL_CATEGORY_ID` | `1` | Воронка сделок («Закупки») |
| `B24_DEAL_DEFAULT_STAGE_ID` | `C1:NEW` | Стадия новой сделки |
| `B24_CATALOG_IBLOCK_ID` | `15` | Инфоблок каталога товаров |
| `B24_UNIT_OKEI_SHT` | `796` | ОКЕИ-код единицы «штука» |

## Тестирование

PHP-контроллеры тестируются **только вручную на dev/боевой коробке** Bitrix24 —
юнит-тестов в репозитории нет (требуется живое ядро Б24 с модулями `crm`,
`iblock`, `shef.iblock`). Покрытие тестами есть у вызывающей стороны —
MCP-инструменты `mcp-overlay/tests/unit/tools/deals/`.
