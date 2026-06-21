# Дизайн: чат-бот Bitrix24 «загрузка счёта в чат»

`Последняя ревизия: 2026-06-21` · Статус: **каркас реализован** (логика + эндпоинт + 30 тестов, §10); боевую часть `imbot.v2.*` + подсистему захвата токена — на портале (§10, §12–§13)

## 1. Что хотим

Сотрудник **бросает файл счёта в чат с ботом** → бот отправляет файл на разбор (тот же пайплайн, что и
веб-загрузка) → **показывает результат** (создана сделка / без сделки + причина) прямо в чате → под
результатом **кнопки 👍 / 👎** для обратной связи. Это альтернатива веб-странице загрузки.

## 2. Почему это отдельная итерация (риски до кода)

1. **Захват и хранение `application_token` — главный «длинный шест».** Сервер **сегодня его не видит**:
   установка чисто клиентская (`useInstall.ts` → `frame.installFinish()`), `/session/b24` валидирует фрейм
   через `app.info` и **ничего не персистит** (`backend/auth.js`). Прод — webhook-режим
   (`NUXT_BITRIX24_OAUTH_ENABLED=false`). Чтобы валидировать входящие события бота, нужен **новый
   механизм**: захватить `application_token` при установке и сохранить (Redis). Без него §5/§11 не
   реализуемы — это не «открытый вопрос», а подсистема. Делать **первым**.
   > 🔧 **Уточнение механизма (2026-06-21, по офиц. доке Б24 — заменяет «клиентский POST токена» ниже в §4):**
   > iframe-установка `application_token` **НЕ отдаёт** (только `AUTH_ID`/`member_id`/`DOMAIN`). Токен
   > приходит **только в серверном событии `ONAPPINSTALL`** (в `auth.application_token`, вместе с
   > `access_token` установившего). Поэтому захват — это **публичный серверный эндпоинт приёма
   > `ONAPPINSTALL`/`ONAPPUNINSTALL`**, а не клиентский POST. Безопасность: **проверить `access_token`
   > из события на портале (`app.info`, SSRF-allowlist — как `/session/b24`) ДО доверия токену**, ключ
   > стора — `member_id`. Allowlist домена сам по себе не аутентифицирует. План — [ROADMAP §4.1](ROADMAP.md).
2. **Используем API чат-ботов 2.0 (`imbot.v2.*`).** Старый `imbot.*`/`ONIMBOT*` официально **устарел**.
   На v2: регистрация `imbot.v2.Bot.register`, события `ONIMBOTV2*`, скачивание файла
   `imbot.v2.File.download`, ответ на команду `imbot.v2.Command.answer`.
3. **Новый публичный серверный эндпоинт** `POST /b24/bot/event` (Б24 ходит снаружи, server→server). Сам по
   себе публичный эндпоинт без `requireAuth` согласуется с моделью приложения (ср. открытые `POST /`,
   `/install`, `/session/b24`); защита — валидация `application_token` (см. п.1) + лимиты.
4. **Новый scope `imbot`** — его **нет** в `getRequiredRights()` (`useB24.ts`: `user_brief,crm,tasks,entity`)
   и в карточке приложения; добавить и переустановить. `im` — только если используем `im.*`-хелперы.
5. **Швы переиспользования требуют рефакторинга** (не «вызвать существующее»): см. §6, §8.
6. **Нельзя проверить без живого портала** — события/скачивание/отправку проверяем ручным QA; парсинг
   события, роутинг, валидацию токена, сборку ответа — юнит-тестами на mock-payload.

## 3. Архитектура и поток

```
Сотрудник → [чат с ботом] → файл
   Б24 (server→server, POST, form-urlencoded) → backend  POST /b24/bot/event
        ├─ ONIMBOTV2MESSAGEADD + файл(ы) в message → imbot.v2.File.download → uploads/ → createAndStartJob*
        │       по готовности → imbot.message.add(результат + KEYBOARD 👍/👎) [auth = data.bot.auth.access_token]
        ├─ ONIMBOTV2COMMANDADD (клик 👍/👎, context=keyboard) → submitFeedback* → imbot.v2.Command.answer
        ├─ ONIMBOTV2JOINCHAT → приветствие
        └─ ONIMBOTV2DELETE → очистка
   * createAndStartJob / submitFeedback — новые ОБЩИЕ хелперы, выделенные из /upload и /feedback (см. §6, §8)
```

**Обратные вызовы бота авторизуются токеном из самого события:** v2-событие несёт
`data.bot.auth.access_token` (OAuth-токен бота) — им и зовём `imbot.*`/`imbot.v2.*`. Отдельный вебхук для
ответов не нужен (это снимает вопрос «webhook vs OAuth» для бота).

## 4. Регистрация бота (при установке)

`imbot.v2.Bot.register` один раз при установке:

```jsonc
imbot.v2.Bot.register({
  code: 'procure_ai_invoice',
  type: 'B',
  eventMode: 'webhook',
  webhookUrl: 'https://<app-домен>/b24/bot/event',   // авто-подписка на все ONIMBOTV2*
  properties: { name: 'Импорт счетов', workPosition: 'Бросьте счёт — создам сделку', color: 'GREEN' },
})  // → BOT_ID
```

- Команды кнопок регистрируем отдельно: `imbot.command.register` (команда `feedback` с обработчиком) —
  нужна, чтобы клик кнопки порождал `ONIMBOTV2COMMANDADD` (см. §7).
- Хранить `BOT_ID` (+ `code`) в Redis-«сторе приложения». `application_token` (см. §2.1) — туда же.
- Идемпотентность: повтор установки → `imbot.v2.Bot.update`; удаление приложения → `imbot.v2.Bot.unregister`.
- **Установка получает серверный шаг:** клиентский `frame.callMethod('imbot.v2.Bot.register', …)` сам по себе
  оставляет сервер без `BOT_ID`/токена — результат и `application_token` надо **отправить POST-ом на новый
  авторизованный backend-роут** и сохранить. Это и есть подсистема из §2.1.

## 5. Серверный эндпоинт `POST /b24/bot/event`

- Тело — `application/x-www-form-urlencoded` (B24 шлёт через `http_build_query`): ключи в PHP-виде
  (`data[bot][id]`, `auth[application_token]`), **все скаляры — строки** → приводить типы явно.
- **Валидация:** сверить **верхнеуровневый** `auth.application_token` с сохранённым при установке
  (главное; не из `data.bot.auth`). Плюс rate-limit и лимит размера тела. На событие отвечаем **200 быстро**
  (Б24 **не гарантирует** повтор при сбое обработчика) — тяжёлый разбор асинхронно, результат отдельным
  сообщением.
- Роутинг по `event`:

| Событие | Действие |
|---|---|
| `ONIMBOTV2MESSAGEADD` + файлы в `message` | скачать файл(ы) → `uploads/` → запустить разбор; ответить «принял…» |
| `ONIMBOTV2COMMANDADD` (`command.context='keyboard'`, наша команда `feedback`) | записать отзыв; `imbot.v2.Command.answer` «спасибо» |
| `ONIMBOTV2MESSAGEADD` без файла | подсказка «бросьте файл счёта (PDF/скан/Excel)» |
| `ONIMBOTV2JOINCHAT` | приветствие + краткая инструкция |
| `ONIMBOTV2DELETE` | очистка `BOT_ID`/состояния |

## 6. Файл из чата → разбор

1. Из `ONIMBOTV2MESSAGEADD` взять файл(ы) из структурного объекта `message` (v2 отдаёт файлы в сообщении —
   в отличие от legacy, где их в событии не было).
2. Скачать: **`imbot.v2.File.download`** (`botId`, `fileId` → `result.downloadUrl`, одноразовый) → загрузить
   по `downloadUrl`. Проверить размер/расширение (те же лимиты, что в `/upload`: `MAX_FILE_SIZE_MB`,
   `ALLOWED_EXTENSIONS`).
3. **Переиспользовать пайплайн через НОВЫЙ общий хелпер `createAndStartJob({files, responsibleUserId})`,
   выделенный из `/upload`** (`backend/index.js`). Сейчас `processJob` **не экспортирован**, а создание
   задания (mkdir `uploads/<jobId>/`, форма `job`, `jobs.set`, гард `maxConcurrentJobs`→429, `recordUpload`,
   запуск `processJob().finally(activeJobs--)`) **заинлайнено** в `/upload` — его надо вынести в функцию и
   звать из обоих мест. Бот обязан соблюдать тот же лимит конкурентности.
4. **`responsibleUserId`** = `user.id` автора (числовой id Б24 — проходит проверку `runAgent`/контроллера).
   **Фолбэк** на дефолт (`PUBLIC_PAGE_RESPONSIBLE_USER_ID`), если автор — бот/внешний/не задан (иначе
   пайплайн вернёт бизнес-ошибку `missing_responsible`).

## 7. Результат + кнопки 👍/👎

По готовности задания — отправить в тот же `dialogId` (`imbot.message.add`, авторизуясь
`data.bot.auth.access_token`):

```jsonc
{
  BOT_ID, DIALOG_ID, CLIENT_ID,
  MESSAGE: 'Готово ✅ Сделка #1609008 — «Импорт прайса от …»\n7 позиций, 3 460.50 byn',
  KEYBOARD: { BUTTONS: [   // именно { BUTTONS: [...] }; при ОБНОВЛЕНИИ клавиатуры нужен и BOT_ID
    { TEXT: '👍 Верно', COMMAND: 'feedback', COMMAND_PARAMS: 'like <jobId>',    BG_COLOR: '#1ec391', TEXT_COLOR: '#ffffff', DISPLAY: 'LINE' },
    { TEXT: '👎 Не то', COMMAND: 'feedback', COMMAND_PARAMS: 'dislike <jobId>', BG_COLOR: '#f56b54', TEXT_COLOR: '#ffffff', DISPLAY: 'LINE' },
  ] },
}
```

- Кнопка с `COMMAND` срабатывает только если команда **зарегистрирована** (`imbot.command.register`, §4).
  Клик порождает **отдельное событие `ONIMBOTV2COMMANDADD`** с `command.context='keyboard'`,
  `command.command='feedback'`, `command.params='like <jobId>'`. Это **не** повторный `ONIMBOTV2MESSAGEADD`.
- Альтернатива без регистрации команды: кнопки с `ACTION:'SEND'`/`ACTION_VALUE` (клик постит текст → обычный
  `ONIMBOTV2MESSAGEADD`, парсим текст) или нативные **реакции** (`ONIMBOTV2REACTIONCHANGE`, `reaction='like'`).
  Решить при реализации; для явных кнопок «лайк/дизлайк» — путь с командой выше.

## 8. Обратная связь (нужен общий хелпер, не HTTP-роут)

Клик 👍/👎 ведёт в тот же канал, что виджет на странице (issue #182), **но не через `POST /feedback`** — тот
**session-authed** (`requireAuth`), у бота сессии нет. Реалистичный шов:
- счётчик: `metrics.recordFeedback({ source: 'user', kind })` — **`source:'user'`** (как у виджета
  сотрудника; `'employee'` в коде нет), `kind ∈ positive|problem|suggestion` (👍→`positive`, 👎→`problem`);
- issue/коммент: вызвать напрямую `buildIssue` + `createGithubIssue` (оба экспортируются из
  `backend/feedback.js`) **или** выделить из роута `/feedback` общий `submitFeedback()` и звать из обоих
  мест. Гейты `requireFeedbackConfigured` + rate-limit сохранить.
- «Кто сообщил» (`feedbackReporter`) в роуте берётся из cookie/сессии — для бота **синтезировать** строку,
  напр. `b24:<portal>/user:<user.id>`.

## 9. Открытые вопросы

1. **Реакции vs кнопки-команды** для 👍/👎 (см. §7) — что предпочесть.
2. **Хранение** `BOT_ID`/`application_token`/`code` — отдельный Redis-namespace «app-config»; формат.
3. **`responsibleUserId`**: подтвердить фолбэк на дефолт и его источник.
4. **Группа vs 1-на-1**: только личный чат с ботом или и групповые (там бота надо упоминать)?
5. **Scope/права**: добавить `imbot` в `getRequiredRights()` + карточку приложения, переустановить.

## 10. План реализации и статус

**✅ Сделано в каркасе (тестируемо без портала, 34 теста `backend/tests/b24-bot.test.js` + 6 `file-validation.test.js` + 6 `app-store.test.js`):**
- **Рефакторы переиспользования:** `createAndStartJob` (из `/upload`) и `createFeedbackIssue` (из
  `/feedback`) — общие замыкания в `backend/index.js`; оба роута переведены на них, поведение не изменилось
  (вся существующая backend-сюита зелёная).
- **Эндпоинт `POST /b24/bot/event`** (`backend/index.js`): разбор form-urlencoded/PHP-ключей
  (`parseBotEvent`), валидация **верхнего** `auth.application_token` (constant-time), быстрый 200, роутинг.
- **Логика бота** (`backend/b24-bot.js`, чистая, I/O инъектируется): сообщение с файлом / **несколько
  файлов в одном сообщении** / **сообщение без файла** (подсказка) / нет ёмкости (занято) / сообщение от
  бота (игнор) / ошибка скачивания; команда `feedback like|dislike` → `submitChatFeedback` (`source:'user'`,
  👍→positive/👎→problem) + «спасибо»; join → приветствие; результат по `onDone` + клавиатура 👍/👎.
- **Безопасность публичного эндпоинта:** IP-rate-limit (`b24BotRateLimit`), SSRF-allowlist на исходящие
  бота (`restEndpoint`/`downloadUrl` только на домены `B24_FRAME_ANCESTORS`, как у `/session/b24`) +
  `redirect:'error'`, лимиты файла (ext, magic-MIME (#216), Content-Length/размер, таймаут, cap числа файлов).
- **Боевая граница** `backend/b24-bot-api.js` (`imbot.v2.File.download`, `imbot.message.add`) — написана,
  **помечена «портал-QA»**, инъектируется (в тестах — мок).
- **✅ Подсистема захвата токена (#217):** `backend/app-store.js` (Redis, хранит sha256-хеш токена по
  `member_id`) + публичный эндпоинт `POST /b24/app/event` (`ONAPPINSTALL`/`ONAPPUPDATE`/`ONAPPUNINSTALL`).
  По офиц. доке Б24: `application_token` приходит **только** в серверном `ONAPPINSTALL` (не в iframe). На
  захвате проверяем `access_token` из события на портале (`app.info`, как `/session/b24`) — allowlist
  домена сам по себе не аутентифицирует. `/b24/bot/event` теперь валиден, если токен **захвачен** ИЛИ
  совпал с env `B24_BOT_APPLICATION_TOKEN` (фолбэк). Покрыто юнит/интеграционными тестами.
- **✅ Scope `imbot`** добавлен в `getRequiredRights()` (`ui/app/composables/useB24.ts`).

**⏳ Осталось (нужен живой портал Б24):**
- **Клиентская регистрация при установке:** `imbot.v2.Bot.register` (бот, `eventMode:'webhook'`,
  `webhookUrl=…/b24/bot/event`) + **`imbot.command.register`** для команды `feedback` (иначе клик кнопки
  не породит `ONIMBOTV2COMMANDADD`) — код в `useInstall.ts`, исполняется на портале.
- **Карточка приложения:** scope `imbot` + указать **«Ссылка-callback для события установки»** =
  `https://<домен>/b24/app/event` (чтобы Б24 прислал `ONAPPINSTALL` с `application_token`); переустановить.
- ~~**MIME-валидация как в `/upload`**~~ — **сделано (#216):** magic-byte-проверка вынесена в общий
  `backend/file-validation.js` (`validateSniffedMime`) и применяется и в `/upload`, и на границе
  скачивания бота (`b24-bot-api.js`) до записи на диск/передачи агенту. Покрыто юнит-тестами.
- **Портал-QA:** сверить фактические форматы `imbot.v2.*` (имена методов/полей, форма файла в `message`,
  домен `downloadUrl` относительно SSRF-allowlist), прогнать сквозной сценарий (§12) и поправить по факту.

## 11. Приёмка

- Личный чат: бросить PDF-счёт → «обрабатываю» → «Готово, Сделка #…» + 👍/👎.
- Кривой документ → «Без сделки + причина» (#192) + 👍/👎.
- Клик 👍/👎 → `/metrics` «Обратная связь» растёт (+ issue при токене).
- Невалидный `auth.application_token` → эндпоинт отвергает (нет создания заданий) — юнит-тест с
  инжектированным сохранённым токеном.

## 12. План ручного тестирования (на ТЕСТОВОМ Битрикс24)

**Подготовка** (на тестовом портале):
1. Установить приложение как **локальное** (`docs/BITRIX24_APP_SETUP.md`), выдать scope **`imbot`**.
2. Раскатать app-образ с **`B24_BOT_APPLICATION_TOKEN`** = `application_token` тестового приложения.
3. Зарегистрировать бота: `imbot.v2.Bot.register` (`eventMode:'webhook'`, `webhookUrl =
   https://<тестовый-домен>/b24/bot/event`); зарегистрировать команду `feedback`
   (`imbot.command.register`).

**Сценарии** (каждый — действие → ожидаемое):
| # | Действие | Ожидается |
|---|---|---|
| 1 | В личном чате с ботом бросить **один** цифровой PDF-счёт (известные поставщик/договор/артикулы) | «Принял, обрабатываю…» → «Готово: … ✅ Сделка #…» + кнопки 👍/👎; сделка реально создана в «Закупках» |
| 2 | Бросить **несколько файлов одним сообщением** | «Принял N файлов…» → один ответ со строкой по каждому файлу |
| 3 | Отправить **два сообщения подряд** с файлами (сценарий «>1 сообщения») | Два **независимых** задания → два ответа |
| 4 | Отправить сообщение **без файла** (просто текст) | Подсказка «бросьте файл счёта…»; задание НЕ создаётся |
| 5 | Кривой/нераспознаваемый документ | «⚠️ Без сделки — <причина>» (#192) + 👍/👎 |
| 6 | Нажать **👍**, затем на другом результате **👎** (требует зарег. команды `feedback`, prep §3 — иначе клик не породит событие) | «Спасибо за оценку»/«Спасибо, учту…»; на `/metrics` «Обратная связь» +1 (+ issue при токене) |
| 7 | (негатив) `curl -X POST …/b24/bot/event` с неверным `auth[application_token]` | **403**, ничего не создаётся |
| 8 | Закидать многими файлами разом (превысить лимит заданий) | «Сейчас много задач… пришлите позже» (без падения) |

**Что смотреть:** `/metrics` (успех, «Обратная связь»), логи `app` (`docker logs procure-app | grep b24bot`),
созданные сделки в воронке «Закупки».

**Если «Принял, обрабатываю…» есть, а результата нет** — обратные вызовы бота берут REST-адрес портала из
**самого события** (`data.bot.auth.client_endpoint`) и токен бота; смотрите в логах `app` ошибки `B24 …
failed` (метод/код). Частые причины: бот зарегистрирован **не** в `eventMode:'webhook'` (тогда событие не
несёт OAuth-токен/endpoint); `downloadUrl` вне SSRF-allowlist (`B24_FRAME_ANCESTORS`) → `outbound host not
allowed`; не выдан scope `imbot`.

## 13. Переключение на БОЕВОЙ Битрикс24

1. На боевом портале установить приложение (локальное), выдать scope **`imbot`**.
2. Зарегистрировать бота на **боевой** обработчик: `imbot.v2.Bot.register` с
   `webhookUrl = https://<боевой-домен>/b24/bot/event`; зарегистрировать команду `feedback`.
3. В `.env.prod` выставить **`B24_BOT_APPLICATION_TOKEN`** = `application_token` **боевого** приложения
   (после реализации подсистемы захвата — проставляется автоматически при установке), `make prod-redeploy`.
4. Прогнать на боевом сценарии **1 и 6** из §12 (один файл + 👍).
5. **Откат:** очистить `B24_BOT_APPLICATION_TOKEN` (эндпоинт → 403, бот выключен) или
   `imbot.v2.Bot.unregister`; раскатать.

> ⚠️ Боевую часть (`b24-bot-api.js`, форматы `imbot.v2.*`) обязательно прогнать на **тестовом** портале
> (§12) ДО боевого — каркас протестирован юнитами, но фактические форматы Б24 сверяются только на портале.

---

> Эталоны: разбор/отзывы — `backend/index.js` (`/upload` `:483-613`, `processJob` `:816`, `/feedback`
> `:689-729`), `backend/feedback.js` (`buildIssue`/`createGithubIssue`), `prompts/main.md`; установка —
> `ui/app/composables/useInstall.ts`, `useB24.ts` (`getRequiredRights`), `docs/BITRIX24_APP_SETUP.md`.
> API Б24 — **чат-боты 2.0** (`imbot.v2.*`, события `ONIMBOTV2*`); сверять с офиц. докой при реализации.
