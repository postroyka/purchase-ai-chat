# Вендоринг `mcp/` (bx24-template-mcp)

`mcp/` — **вендоренная копия** upstream-шаблона MCP-сервера. Напрямую её не правим:
всё своё (procurement-инструменты `b24_pst_crm_*`) живёт в `mcp-overlay/` и
накладывается поверх при сборке образа (см. `Dockerfile.mcp`).

## Текущий снимок

| | |
|---|---|
| Upstream | https://github.com/bitrix24/templates-mcp |
| Версия | **v0.3.0** |
| Тег → коммит | `v0.3.0` = `a65b8bbefc86df118b827cff1420c3ecfbd345b2` |
| Снят | 2026-06-18 (PR #154) |

## Как обновлять (ре-вендор)

`mcp/` исторически импортирован через `git subtree`, но ре-вендор делаем **зеркалированием**
(rsync) — надёжнее и без конфликтов при крупных скачках версий. Это каноническая процедура
(корневой `README.md` ссылается сюда). Всегда по ТЕГУ (не `main` — он движется без ревью):

1. Снять новый релиз upstream **полным** клоном (НЕ `--depth 1` — на шаге 3 нужна история
   до записанного SHA, иначе `git diff` упадёт с `fatal: invalid object`):
   ```bash
   git clone --branch <vX.Y.Z> https://github.com/bitrix24/templates-mcp /tmp/tpl
   ```
2. Зеркалировать в `mcp/`, не трогая артефакты/зависимости:
   ```bash
   rsync -a --delete \
     --exclude .git --exclude node_modules --exclude .nuxt --exclude .output \
     /tmp/tpl/ mcp/
   ```
3. Сверить дельту с записанным выше SHA — видно только реальные изменения upstream:
   ```bash
   git -C /tmp/tpl diff a65b8bbefc86df118b827cff1420c3ecfbd345b2..<vX.Y.Z> -- .
   ```
4. Локальных правок **внутри** `mcp/` быть не должно — всё в `mcp-overlay/`
   (единственный исторический патч #127 уже влит в upstream и растворился).
5. Проверить совместимость overlay: скопировать deals в `mcp/server/mcp/tools/deals`
   **и shared-utils** (`cp -r ../mcp-overlay/server/utils/. mcp/server/utils/` — там
   `rest-timing.ts`, #262, который импортируют deals), `pnpm typecheck`, затем убрать.
   Полную сборку образа валидирует CI-джоб «Validate Docker builds».
6. Обновить **этот файл** (версия/SHA/дата) и при необходимости `Dockerfile.mcp`
   (напр. v0.3.0 добавил нативный `better-sqlite3` → `apk add python3 make g++`).

## Обновление зависимостей: `mcp/`-конфиги ИНЕРТНЫ (issue #211)

Вендоренные `mcp/.github/dependabot.yml` и `mcp/renovate.json` (из upstream-шаблона) в этом монорепо
**не работают**: GitHub Dependabot читает только **корневой** `.github/dependabot.yml` (вложенный — не на
корне → игнорируется), а Renovate в репо не установлен (корневого `renovate.json` нет). npm-зависимости
`mcp/` ведёт **корневой** Dependabot (есть запись `directory: /mcp`). Эти файлы оставлены как есть ради
точности зеркала (ре-вендор `rsync --delete` их всё равно восстановит) — просто не считайте их
действующими.

## Что мы меняем относительно upstream (в сборке, не в `mcp/`)

- `Dockerfile.mcp` удаляет `server/mcp/tools/{tasks,users,meta}` — нужны только
  `b24_pst_crm_*` (overlay). Срез подтверждается assert'ом в Dockerfile.
- OAuth/DXT-мультитенант выключен и закреплён на уровне образа
  (`ENV NUXT_BITRIX24_OAUTH_ENABLED=false`). Мы — webhook-only (`NUXT_MCP_AUTH_TOKEN`).
  ⚠️ Включать OAuth только с **постоянным томом** под SQLite-token-store (`better-sqlite3`):
  без тома Bearer-токены лежат в эфемерном слое контейнера и теряются при рестарте
  (пользователи получат 401). Детали флага — в `mcp/.env.example` (блок OAUTH).
