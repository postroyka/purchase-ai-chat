# Инструкция владельцу репозитория — токены и работа с Git

`Аудитория: владелец GitHub-репозитория / тех-ответственный.` Эксплуатация сервера — [GUIDE_ADMIN.md](GUIDE_ADMIN.md); полные env-переменные — `.env.prod.example`.

---

## 1. Токены: что есть и где живёт

Токены **никогда не коммитятся** в репозиторий. Два места хранения:

### A. Секреты приложения — в `.env.prod` **на сервере** (не в Git)
Генерация криптотокенов: `openssl rand -hex 32`.

| Переменная | Назначение | Как получить |
|---|---|---|
| `BACKEND_API_TOKEN` | серверный API-токен (программные/MCP-вызовы) | `openssl rand -hex 32` |
| `NUXT_MCP_AUTH_TOKEN` | защита `/mcp` (мин. 32 симв.) | `openssl rand -hex 32` |
| `REDIS_PASSWORD` (+ в `REDIS_URL`) | пароль Redis | `openssl rand -hex 32` |
| `PUBLIC_PAGE_BASIC_AUTH_PASS` | пароль входа вне портала (и `/metrics`) | задать вручную |
| `SESSION_SECRET` _(опц.)_ | подпись сессионной cookie | `openssl rand -hex 32` |
| `NUXT_BITRIX24_WEBHOOK_URL` | вебхук Bitrix24 (CRM + scope `shef:purchase.api.*`) | создать в Б24 |
| `ANTHROPIC_API_KEY` _(или ключи DeepSeek)_ | доступ к модели ИИ | у провайдера модели |
| `B24_BOT_APPLICATION_TOKEN` _(опц.)_ | фолбэк токена чат-бота Б24 | обычно захватывается авто |

### B. Секреты CI/деплоя — в **GitHub → Settings → Secrets and variables → Actions**
| Секрет | Назначение |
|---|---|
| (встроенный `GITHUB_TOKEN`) | публикация образов в GHCR из Actions — отдельно заводить не нужно |
| `WEBHOOK_URL` | пост-деплой health-чек контроллера Bitrix24 (`Deploy b24-controller`) |
| `B24_SSH_HOST` / `B24_SSH_USER` / `B24_SSH_PORT` / `B24_SSH_PASS` | SSH-выкладка PHP-контроллера |
| `B24_CONTROLLERS_PATH` | путь к `…/shef.purchase/lib/controllers` на портале |

> Для **локального** пула приватных образов GHCR нужен персональный PAT с правом `read:packages` (`docker login ghcr.io`). Для пуша образов вручную (минуя Actions) — PAT с `write:packages` (`GHCR_TOKEN`, см. `scripts/deploy-images.sh`).

### Правила обращения с токенами
- **Не коммитить** ни в коде, ни в истории. `.env.prod` — только на сервере, копия — в защищённом менеджере секретов **вне сервера**.
- **Ротация** при утечке/периодически: сгенерировать заново → заменить в `.env.prod` → `make prod-redeploy` (для секретов приложения) или в GitHub Secrets (для CI). Список приложения — таблица A.
- В логах секреты **редактируются**; «живой» токен в логе — это баг (завести issue).
- Включить на GitHub: **Secret scanning** и **Dependabot alerts** (Settings → Code security).

---

## 2. Как работать с репозиторием

### Поток изменений (continuous deployment)
```
ветка feature/fix → Pull Request → зелёный CI → merge в main → Watchtower выкатывает на прод
```
- **Никогда не пушить напрямую в `main`** — только через PR (правило в `CLAUDE.md`).
- **`main` = прод.** Каждый зелёный коммит `main` автоматически собирается в образ (GHCR) и подхватывается Watchtower на сервере (~5 мин). Релиз-тег для деплоя **не обязателен**.
- **CI — это гейт:** красный CI до сборки образов не доходит, на прод не уезжает.
- **Merges в `main` — вручную** (вы как владелец). Рекомендуется включить **branch protection** на `main` (требовать зелёный CI + PR).

### Релизы и откат
- **Релиз-метка** (опционально): тег `v*` помечает точку релиза/отката, на сам деплой не влияет.
- **Откат:** запинить известный-хороший `sha-<commit>` образ в `.env.prod` (`APP_IMAGE_TAG`/`MCP_IMAGE_TAG`) и остановить Watchtower, чтобы не перекатил обратно. Пошагово — [OPERATIONS.md §4](OPERATIONS.md).

### Пауза сервиса (рубильник)
Приостановить приём без сноса стека и без потери данных — env-флаг `MAINTENANCE_MODE`:
```
# в .env.prod на сервере
MAINTENANCE_MODE=true
MAINTENANCE_MESSAGE=Подписание актов выполненных работ   # подпись снизу заглушки
```
затем `make prod-redeploy`. Приложение отдаёт страницу-заглушку и `503` на API (приём файлов и создание
сделок остановлены), контейнер остаётся healthy, тома `uploads`/`redis-data` целы. Снять паузу — вернуть
`MAINTENANCE_MODE=false` + `make prod-redeploy`. Полное выключение стека — `make prod-down`.

### Что деплоится не через Watchtower
- **PHP-модуль Bitrix24** (`shef:purchase.api.*`) живёт на портале — выкладывается **отдельно**: `make deploy-b24 APPLY=1` или workflow **«Deploy b24-controller»**. Связка MCP↔PHP едет двумя сторонами.
  > ⚠️ Правило (`CLAUDE.md`): НДС-модель сделки (#326) держится на **кастомной правке ядра** заказчика `CCrmProductRow::SaveRows`. Это правка **в ядре Bitrix** — перезатирается при обновлении портала, её нужно **сохранять/ре-патчить**.

### Где смотреть состояние
- **Actions** — зелёный CI = образ уехал в прод; статусы деплоя.
- **Pull requests** — изменения и обновления зависимостей (Dependabot).
- **Security** — алерты Dependabot / secret-scanning.

### Зависимости
Обновления npm/docker/actions приходят PR-ами (Dependabot, корневой `.github/dependabot.yml`). Ваш маршрут: ревью → мерж → CI → авто-деплой.

---

> Связанные доки: эксплуатация/откат/бэкапы — [OPERATIONS.md](OPERATIONS.md); установка сервера — [SERVER_SETUP.md](SERVER_SETUP.md); все env — `.env.prod.example`; правила репозитория — `CLAUDE.md`.
