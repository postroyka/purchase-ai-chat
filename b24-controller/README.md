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
| `shef.purchase.api.procureproduct.findByVendorCode` | `ProcureProduct` | ✅ реализован (B4), нормализация — B5 |
| `shef.purchase.api.procurecontract.find` | `ProcureContract` | ⏳ B3b–B3e |
| `shef.purchase.api.procuredeal.create` | `ProcureDeal` | ⏳ B6–B7 (B8 подтверждён) |

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

Параметры берутся из окружения (или `.env.deploy`, см. `.env.deploy.example`):
`B24_SSH_HOST`, `B24_SSH_USER`, `B24_SSH_PORT`, `B24_CONTROLLERS_PATH`.

Скрипт ([`scripts/deploy-b24-controller.sh`](../scripts/deploy-b24-controller.sh)):
- копирует **только** `b24-controller/lib/controllers/procure*.php`;
- `rsync` **без** `--delete` — чужие файлы модуля `shef.purchase` не затрагиваются;
- по умолчанию делает dry-run; реальная выкладка — `make deploy-b24 APPLY=1`.

Папка исключена из Docker-образов (`.dockerignore`).
