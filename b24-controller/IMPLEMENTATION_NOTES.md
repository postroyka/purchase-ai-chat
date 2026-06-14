# b24-controller — заметки реализации

Сводка по структурам Bitrix24 (коробка `b24.postroyka.by`), собранная из примеров заказчика.
Используется при реализации контроллеров `Shef\Purchase\Controllers\Procure*`.

> ⚠️ Модуль `shef.purchase` — **живой код заказчика**. Мы добавляем ТОЛЬКО новые
> контроллеры `lib/controllers/procure*.php`. Ничего существующего не трогаем.

## Регистрация контроллеров (REST)

`shef.purchase/.settings.php`:
```php
'controllers' => ['value' => [
    'namespaces' => ['\\Shef\\Purchase\\Controllers' => 'api'],
    'restIntegration' => ['enabled' => true],
]]
```
→ REST-метод формируется как `shef:purchase.api.<controller>.<action>`.
> Двоеточие (`shef:purchase`, не `shef.purchase`) — разделитель `модуль:scope`
> у кастомных коробочных модулей Б24. С точкой метод не находится:
> `ERROR_METHOD_NOT_FOUND`.

Паттерн контроллера (из `returning.php`, `returningreport.php`):
- `extends \Bitrix\Main\Engine\Controller`
- `use Shef\Options\TraitList\Modules;` + `getModulesList(): array` — ленивый includeModule
- `configureActions()` → `prefilters => parent::getDefaultPreFilters()`
- Экшены `<name>Action(...)`, возврат `?array`, ошибки через `$this->addError(new Error('msg', 'code'))`

## B1 — Поставщик (по УНП)

УНП хранится в **реквизите** компании, не в поле:
```php
$filter = ['RQ' => [[
    'COUNTRY_ID' => \Bitrix\Main\Config\Option::get('crm', 'crm_requisite_preset_country_id', 4), // 4 = Беларусь
    'FIELD_NAME' => 'RQ_INN',
    'OPERATION'  => '=',   // точное совпадение (бизнес-правило)
    'VALUE'      => $unp,
]]];
$dbResult = \CCrmCompany::GetListEx(
    ['ID' => 'ASC'],            // мин. ID при дублях
    $filter, false, ['nTopCount' => 1],
    ['ID', 'TITLE', 'COMPANY_TYPE', 'INDUSTRY', 'LOGO']
);
```
Несколько компаний с одним УНП → берём минимальный ID.

## B2 — Договор (инфоблок-список)

- `IBLOCK_ID = 32`, namespace `Shef\IBlock\Lists\Dogovor` (модуль `shef.iblock`)
- Доступ к полям: `Dogovor\Entity::getInstance()`

| Поле (CODE) | Класс | Назначение |
|---|---|---|
| `CLIENT` | `Fields\IBlock\Client` | CRM-привязка: `CO_<companyId>` (компания) / `C_<contactId>` |
| `MYCOMPANY` | `MyCompany` | Наша компания |
| `NUMBER` | `Number` (string) | Номер договора |
| `DATE` | `Date` | Дата |
| `TYPE` | `Type` (enum) | `SALE` / `PURCHASE` / `PURCHASE_ZAK` / `OTHER` |
| `SIGN` | `Sign` (enum) | `LONG_TERM` / `ONE_TIME` |
| `STATUS` | `Status` (enum) | `NEW` / `APPROVE` / `VISE` / `ORIG` / `TO_DELETE` |
| `IS_USED` | `isUsed` (enum) | использован в отгрузке |
| `IS_ORIG` | `isOrig` (enum) | оригиналы получены |
| `TARGETEXT` | `TargetExt` (enum) | цель приобретения (актуальное; `TARGET` — deprecated) |
| `ASSIGNED` | `Assigned` | ответственный |

Группы статусов (готовые методы класса `Status`):
- `getStatusWork()` = [NEW, APPROVE, VISE]
- `getStatusStopWork()` = [ORIG, TO_DELETE]

Enum-ID резолвятся через методы полей, напр. `->getField('TYPE')->getStatusPurchase()`.

### Критерии поиска договора (B3)
Фильтр:
- `CLIENT = CO_<supplierId>` — **B3a подтверждено**. Привязка к CRM-сущности
  хранится как `CO_<id>` (компания) / `C_<id>` (контакт) — см. `Dogovor\Fields\IBlock\Client`.
- `ACTIVE = Y` (штатное поле элемента)
- `STATUS` ≠ брак (`TO_DELETE`)
- `TYPE` ∈ { Закупки (`PURCHASE`), Закупки-Комиссионный (`PURCHASE_ZAK`) }
- `NUMBER` (свойство) — номер договора
- `DATE` (свойство) — дата договора

### Реализовано (из shef.iblock.zip, B3b–B3e закрыто)

Модуль `shef.iblock` предоставляет `Shef\IBlock\Lists\Dogovor\Entity` (extends `AEntity`).

**Способ чтения (B3e):** `Dogovor\Entity::getList(['filter'=>..., 'order'=>..., 'limit'=>N, 'select'=>[...]])` — static метод из `AEntity::getList` → внутри вызывает `Element::getListInner` с `ACTIVE=Y` автоматически.

**Enum ID (B3b–e):** не зашиваются — резолвятся через методы полей:
```php
$entity = Dogovor\Entity::getInstance();
$statusField = $entity->getField('STATUS'); // getStatusToDelete(), getStatusWork(), …
$typeField   = $entity->getField('TYPE');   // getStatusPurchase(), getStatusPurchaseZak()
$clientField = $entity->getField('CLIENT'); // getPropertyId()
```
В фильтр передаётся ключ `PROPERTY_<propertyId>` (получается через `->getPropertyId()`).

**NUMBER (B3b):** exact match (`=PROPERTY_<id>`). Нормализация не нужна — хранится как введено.

**DATE (B3c):** exact day equality (`=PROPERTY_<id>`, формат `d.m.Y`). «Действует на дату» (диапазон) не реализуем — в схеме одно поле DATE, не FROM/TO.

**При нескольких совпадениях (B3d):** минимальный ID (`order => ['ID' => 'ASC'], limit => 1`) — аналогично правилу поставщика.

## B4 — Товар (каталог)

- `IBLOCK_ID = 15` (каталог; опция `B24_CATALOG_IBLOCK_ID`, default 15 — читается через `\Shef\Purchase\Config::getCatalogIblockId()`)
- Фильтр матчинга по артикулу поставщика:
  - `ACTIVE = Y` (штатное поле)
  - `PROPERTY_PURCHASE_ARTICLE` = артикул поставщика из документа
  - `PROPERTY_PURCHASE_69_PARENT_PRODUCT` **пустое** → только родительский товар
- Несколько найдено → **минимальный ID** (бизнес-правило).
- Один товар может иметь 2 артикула поставщика (R-12): хранится один; второй не
  находится → предупреждение, позиция не привязывается (ручная обработка).

**B5 подтверждено:** `PURCHASE_ARTICLE` — точное совпадение (`=PROPERTY_PURCHASE_ARTICLE`).
**Гомоглифы:** артикул мог быть набран латиницей или кириллицей (напр. «тех 100х25х6000»);
каталог большой → фолд в SQL невозможен, поэтому `Config::homoglyphVariants()` генерирует
варианты (замена спорных букв в обе стороны) и матчит их через `IN` (`=PROPERTY ... => [...]`).
При комбинаторном взрыве (> 64 вариантов) — только исходная строка.

### Договор — номер и дата (гомоглиф-устойчиво)
Номер договора (напр. `243Э20`) и дата сверяются **в PHP, а не в SQL-фильтре**:
- номер — через `Config::foldHomoglyphs()` (верхний регистр + спорные кирилл-буквы → латиница);
- дата — по отображаемому `d.m.Y` (не зависит от внутреннего формата свойства).
Берутся все договоры поставщика (их немного), возвращается первый подошедший по
`order ID ASC` = минимальный ID.

## Сделка (B6–B8)

- **B8 подтверждено:** `CATEGORY_ID = 1` («Закупки»), `STAGE_ID = C1:NEW`,
  `RESPONSIBLE_ID` = `b_user.ID` (целое). `CURRENCY_ID = BYN`.
- Позиции: `TAX_RATE = 20`, `TAX_INCLUDED = Y`, единица = шт, цена = `priceExclVat`.
- Сделка создаётся всегда (дублей не проверяем).
- **`BEGINDATE` («Дата начала») — обязательное поле воронки «Закупки».**
  Заполняется: если передан `documentDate` (дата счёта, формат d.m.Y) — это дата
  на 09:00 (документ оформлен утром); иначе — текущие дата-время. Без этого
  `CCrmDeal::Add` падает с `deal:030` («Не введено значение обязательного поля
  "Дата начала"»).

### B6 — вложение файла ✅ реализовано
Файл приходит как base64 (MCP читает его из uploads-тома по `filePath`).
`\CRestUtil::saveFile([$fileName, $fileContent])` → `$deal->Update($id, ['UF_CRM_DEAL_SH_PRCHS_AI_FILE' => $fileArray])`.
Сбой вложения не валит сделку — попадает в `warnings`.
Имя файла **санитизируется** перед `saveFile` (`sanitizeFileName`, #103) — см. ниже.

### B7 — лог-комментарий ✅ реализовано
`processingLog` пишется в поле `COMMENTS` при `CCrmDeal::Add`, и отдельно в таймлайн:
`\Bitrix\Crm\Timeline\CommentEntry::create(...)` + `CommentController::getInstance()->onCreate(...)`.

### Привязка договора ✅
`contractId` → `UF_CRM_DEAL_DOGOVOR` (поле подтверждено заказчиком).

### Итог по `createAction`
Полностью реализован: `CCrmDeal::Add` (с `UF_CRM_DEAL_DOGOVOR`), `SaveProductRows`
(результат проверяется), вложение файла (B6), таймлайн-лог (B7). Некритичные сбои
(позиции/файл) возвращаются в `warnings`, сделку не откатывают. Единица измерения —
ОКЕИ-код (опция `B24_UNIT_OKEI_SHT`, default 796 — через
`\Shef\Purchase\Config::getUnitOkeiSht()`), позиции с защитой от
отрицательной цены/нулевого кол-ва, потолок `MAX_ITEMS = 500`. Воронка и стадия —
`Config::getDealCategoryId()` / `getDealDefaultStageId()` (опции
`B24_DEAL_CATEGORY_ID`=1, `B24_DEAL_DEFAULT_STAGE_ID`=C1:NEW).

## Безопасность (#103)

Контроллер может вызываться и **напрямую по REST** (вебхуком), в обход MCP-слоя —
поэтому защита дублируется на стороне контроллера, а не только в MCP.

1. **Санитизация `fileName` ✅ реализовано** (`sanitizeFileName`). `fileName` приходит из
   недоверенного документа и уходит в `title` и `CRestUtil::saveFile`. Приводим к
   безопасному виду: `basename` (срез пути `../`/`/etc/...`/`C:\...`), удаление ASCII
   control-символов (анти log/header-injection), белый список расширений
   (`ALLOWED_FILE_EXT`; иначе `.bin`), лимит длины (`MAX_FILE_NAME_LEN`). Покрыто
   тестами `testFileNameSanitizedBeforeSaveFile` / `testLegitFileNamePreserved`.

2. **AuthZ REST — проверить на коробке.** Все контроллеры защищены
   `parent::getDefaultPreFilters()` из модуля `shef.purchase` (его нет в этом репо).
   ⚠️ Перед продом **подтвердить на коробке**, что состав prefilters включает
   `Bitrix\Main\Engine\ActionFilter\Authentication` (и при необходимости `Csrf`),
   а **scope вебхука минимизирован** (только нужные методы CRM). Без аутентификации
   обладатель вебхука сможет массово создавать сделки/грузить файлы.

3. **Basic-auth публичной страницы.** Дефолтный логин `PUBLIC_PAGE_BASIC_AUTH_USER`
   предсказуем (`procure`) — **обязательно сменить** в `.env.prod` на нетривиальный, и
   задать стойкий `PUBLIC_PAGE_BASIC_AUTH_PASS`. Лимит неуспешных попыток (anti-bruteforce)
   — на уровне nginx-proxy (fail2ban) при развёртывании.
