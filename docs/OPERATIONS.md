# Эксплуатация и сопровождение

`Последняя ревизия: 2026-06-20`

Что держать под контролем после запуска и как обновлять систему. Первичная подготовка сервера — в
[`SERVER_SETUP.md`](SERVER_SETUP.md); on-call по MCP (алерты→действие) — в [`../mcp/docs/RUNBOOK.md`](../mcp/docs/RUNBOOK.md).

## TL;DR

```bash
make prod-up        # поднять/обновить стек (pull образов + up -d)
make logs           # хвост логов всех контейнеров
docker compose -p procure-ai ps    # статус + health контейнеров
make prod-redeploy  # форс-обновление образов сейчас (не ждать Watchtower)
```

- **app** и **mcp** обновляются **автоматически** (Watchtower, каждые 5 мин, из GHCR).
- **redis** и базовые образы обновляются **вручную**.
- Откат — пином `APP_IMAGE_TAG`/`MCP_IMAGE_TAG` в `.env.prod` (см. §4).

## 1. Что крутится в проде

| Контейнер | Образ | Автообновление | Healthcheck | Лимиты |
|---|---|---|---|---|
| `procure-app` | `ghcr.io/postroyka/procure-ai-app` | ✅ Watchtower | `GET /health` | 1 CPU / 768 MB |
| `procure-mcp` | `ghcr.io/postroyka/procure-ai-mcp` | ✅ Watchtower | `GET /api/health` (внутр.) | 0.5 CPU / 512 MB |
| `procure-redis` | `redis:7-alpine` | ❌ вручную | `redis-cli ping` | — |
| `procure-watchtower` | `containrrr/watchtower:1.7.1` (pinned) | ❌ (не самообновляется) | — | 0.2 CPU / 128 MB |
| nginx-proxy + acme | отдельный стек `procure-proxy` | — | — | TLS/домен |

`app` смотрит наружу (через nginx-proxy), `mcp`+`redis` — только во внутренней сети `procure-net`. Тома:
`uploads` (app rw, mcp ro), `redis-data`.

## 2. Что контролировать после запуска

### 2.1. Здоровье сервисов
```bash
docker compose -p procure-ai ps          # все должны быть healthy/running
curl -fsS https://<домен>/health          # app → 200 (проверяет и Redis)
docker inspect --format '{{.RestartCount}}' procure-app procure-mcp   # частые рестарты = проблема
```
`/health` падает → app не готов (обычно Redis недоступен). `procure-mcp` unhealthy → агент не сможет
создавать сделки (поиск/создание уйдут в ошибку).

### 2.2. Дашборд `/metrics`
Открыть `https://<домен>/metrics` (внутри Bitrix24 — пункт «Метрики»). Смотреть:
- **Успешных сделок / % успеха** — резкое падение = регресс распознавания или B24/1С недоступен.
- **Среднее время агента** — растёт = провайдер тормозит или модель сменилась (ср. с порогами
  «быстро/медленно», [`PARSING_PERFORMANCE.md`](PARSING_PERFORMANCE.md)).
- **Стоимость модели** — контроль бюджета.
- **Сигналы качества (агент)** и **Обратная связь** — что мешает агенту/что просят сотрудники.

### 2.3. Очередь и Redis
```bash
make shell-app  # внутри: env | grep REDIS_URL
docker exec procure-redis sh -c 'REDISCLI_AUTH=$REDIS_PASSWORD redis-cli info memory | grep used_memory_human'
```
Redis хранит задания (TTL `JOB_TTL_HOURS`, по умолч. 24 ч) и стейт rate-limiter. Персист — AOF
(`--appendonly yes`) в томе `redis-data`.

### 2.4. Диск и `uploads`
Загруженные файлы копятся в томе `uploads`; авто-чистка удаляет папки заданий старше
`UPLOADS_RETENTION_DAYS` (по умолч. 7). Контроль:
```bash
df -h                                   # место на диске
docker system df                        # объём образов/томов/кэша
docker builder prune -f                 # подчистить build-кэш при нехватке
```

### 2.5. Логи
```bash
make logs                                       # все контейнеры
docker logs --tail 200 -f procure-app           # только app
docker logs --tail 200 procure-mcp              # MCP (вызовы B24/1С)
```
На что смотреть: `[processJob] error …` (сбой обработки файла), `[agent …] …` (ретраи провайдера),
ошибки Redis. Токены в логах **редактируются** — если увидели «живой» секрет, это баг, заводите issue.

### 2.6. Каналы обратной связи (GitHub)
Если задан `GITHUB_FEEDBACK_TOKEN` — отзывы сотрудников и сигналы агента заводят **issue** в приватном
репо (метки `agent-feedback`/`feedback:*`). Раз в неделю просматривать. Детали —
[`FEEDBACK.md`](FEEDBACK.md). Без токена канал считается выключенным (счётчики в `/metrics` пишутся всё
равно).

### 2.7. TLS/домен
Сертификат обновляет acme-companion (отдельный стек). Проверка срока: `curl -vI https://<домен> 2>&1 | grep -i expire` или браузером. Продление автоматическое; алерт — если до истечения < 14 дней.

## 3. Как обновлять систему

### 3.1. Приложение и MCP — автоматически (Watchtower), continuous deployment
Поток: **git → зелёный CI → образ в GHCR → Watchtower подхватывает**. **CI и есть гейт** — на прод едут
только зелёные коммиты `main` (красный CI до сборки образов не доходит).
- `push` в `main` → **после зелёного CI** (триггер `workflow_run`) публикуются `:latest` **и** `sha-<sha>`.
  То есть каждый зелёный коммит main автоматически уезжает в прод (релиз-тег **не** обязателен).
- Тег `v*` или ручной `workflow_dispatch` (тоже под зелёным CI) → то же самое + помечает **опциональную**
  точку релиза/отката. Не требуется для деплоя.
- Watchtower на сервере каждые **300 c** тянет новый `:latest` для `procure-app`/`procure-mcp` и
  пересоздаёт их (scope `procure-ai` — не трогает чужие контейнеры). `sha-<sha>` хранятся для отката (§4).

Форс-обновление сейчас (не ждать 5 минут):
```bash
make prod-redeploy     # pull + up -d (или make prod-pull — только подтянуть образы)
```

### 3.2. Зависимости (npm/pnpm-пакеты)
- Обновления пакетов приходят **PR-ами**. Корневой `.github/dependabot.yml` ведёт их по всему репо:
  **npm** (`backend`, `ui`, `mcp`, `mcp-overlay`), **docker** (Node — только patch) и **github-actions**.
  Вендоренные `mcp/.github/dependabot.yml` + `mcp/renovate.json` (от шаблона) — **инертны** (GitHub читает
  только корневой конфиг; Renovate не установлен), см. `../mcp/VENDOR.md`. Ревью → мерж → CI → Watchtower.
- Активность git/CI смотреть на GitHub: вкладка **Actions** (зелёный CI = образ уехал в прод),
  **Pull requests** (Dependabot/Renovate), **Security** (Dependabot alerts).

### 3.3. Redis и базовые образы — вручную
`redis:7-alpine` **не** под Watchtower (официальный образ, осознанно). Обновлять руками, со снапшотом:
```bash
docker exec procure-redis sh -c 'REDISCLI_AUTH=$REDIS_PASSWORD redis-cli save'   # дамп перед обновлением
docker compose -p procure-ai pull redis && docker compose -p procure-ai up -d redis
```

### 3.4. Watchtower — pinned
Сам Watchtower зафиксирован на версии (`1.7.1`) и **не** самообновляется (он монтирует docker.sock —
supply-chain-риск). Поднимать версию — осознанно, правкой compose.

### 3.5. PHP-модуль Bitrix24 (`b24-controller`) — отдельный деплой
REST-контроллеры (`shef:purchase.api.*`) живут на портале Bitrix24, **не** в Docker. Обновляются отдельно
(`make deploy-b24` или вручную выкладкой `config.php` + `procure*.php`). Помнить про связку MCP↔PHP: правки
контракта едут двумя сторонами (чек-лист деплоя MCP↔PHP — PR #78).

## 4. Откат (rollback)

CI не ходит на прод по SSH — откат ручной (подробно в [`../mcp/docs/RUNBOOK.md#rollback`](../mcp/docs/RUNBOOK.md#rollback)):
```bash
# 1) остановить Watchtower, чтобы не перекатил обратно на :latest
docker stop procure-watchtower
# 2) запинить известный-хороший тег (sha-… без 'v') в .env.prod, НЕ инлайном:
#    APP_IMAGE_TAG=sha-<good>   MCP_IMAGE_TAG=sha-<good>
# 3) применить и вернуть Watchtower:
make prod-up && docker start procure-watchtower
```

## 5. Бэкапы

| Что | Где | Как снять |
|---|---|---|
| Задания/стейт | том `redis-data` (AOF) | `redis-cli save` + копия тома, либо `docker run --rm -v procure-ai_redis-data:/d -v $PWD:/b alpine tar czf /b/redis.tgz -C /d .` |
| Загруженные файлы | том `uploads` | аналогично tar тома `procure-ai_uploads` (учесть `UPLOADS_RETENTION_DAYS` — старое чистится) |
| Конфиг | `.env.prod` (секреты!) | хранить вне сервера в защищённом месте |

TLS-сертификаты принадлежат стеку `procure-proxy` — `down -v` в `procure-ai` их **не** трогает.

## 6. Безопасность в сопровождении

- **Ротация токенов** при утечке/периодически: `BACKEND_API_TOKEN`, `NUXT_MCP_AUTH_TOKEN`,
  `NUXT_BITRIX24_WEBHOOK_URL`, `GITHUB_FEEDBACK_TOKEN`, `PUBLIC_PAGE_BASIC_AUTH_PASS`, `REDIS_PASSWORD`
  (`openssl rand -hex 32`), затем `make prod-redeploy`.
- `GITHUB_FEEDBACK_TOKEN` — **fine-grained PAT**, только репо фидбэка (по умолч. `postroyka/purchase-ai-chat`),
  Issues: R/W; бэкенд на старте **предупреждает в лог**, если этот репо публичный (мягкая проверка, не гейт).
- На GitHub держать включёнными CI security-гейты (secret-scanning, Dependabot alerts).

## 7. Связанные документы

- [`SERVER_SETUP.md`](SERVER_SETUP.md) — первичная подготовка сервера + два compose-стека.
- [`../mcp/docs/RUNBOOK.md`](../mcp/docs/RUNBOOK.md) — on-call: алерт→действие, откат, разбор по логам.
- [`../mcp/docs/DEPLOYMENT.md`](../mcp/docs/DEPLOYMENT.md) — деплой MCP-образа.
- [`BITRIX24_APP_SETUP.md`](BITRIX24_APP_SETUP.md) — приложение/портал. [`FEEDBACK.md`](FEEDBACK.md) — каналы отзывов.
- [`PARSING_PERFORMANCE.md`](PARSING_PERFORMANCE.md) — «быстро/медленно», калибровка порогов.
