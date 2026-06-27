# Инструкция сисадмину — профилактика сервера

`Аудитория: системный администратор сервера с приложением.` Это **краткий регламент профилактики**; полный справочник по эксплуатации, откату и бэкапам — [OPERATIONS.md](OPERATIONS.md), первичная установка — [SERVER_SETUP.md](SERVER_SETUP.md).

## Что крутится (коротко)
| Контейнер | Что | Обновление | Лимиты |
|---|---|---|---|
| `procure-app` | приложение (UI+API) | ✅ авто (Watchtower) | 1 CPU / 768 MB |
| `procure-mcp` | мост к Bitrix24 | ✅ авто (Watchtower) | 0.5 CPU / 512 MB |
| `procure-redis` | очередь заданий/стейт | ❌ вручную | — |
| `procure-watchtower` | автодеплой образов | ❌ (pinned) | — |
| nginx-proxy + acme | TLS/домен (стек `procure-proxy`) | — | — |

Тома: **`uploads`** (загруженные файлы), **`redis-data`** (задания, AOF).

## Регламент профилактики

### Ежедневно (2 мин)
```bash
curl -fsS https://<домен>/health          # → 200; { ok:true, redis:"ok", feedbackOutboxPending:0 }
docker compose -p procure-ai ps           # все healthy/running
df -h                                     # место на диске
```
- `/health` ≠ 200 → приложение не готово (чаще всего недоступен Redis).
- `procure-mcp` unhealthy → сделки не создаются (поиск/создание уйдут в ошибку).
- `feedbackOutboxPending` стабильно растёт → GitHub недоступен или протух `GITHUB_FEEDBACK_TOKEN`.

### Еженедельно (15 мин)
1. **Логи** — нет ли повторяющихся сбоев:
   ```bash
   docker logs --tail 200 procure-app    # [processJob] error …, ретраи агента, ошибки Redis
   docker logs --tail 200 procure-mcp    # вызовы Bitrix24
   ```
   Секреты в логах редактируются; увидели «живой» токен — это баг, завести issue.
2. **Бэкап** (см. OPERATIONS §5): снять том `redis-data` (+`redis-cli save`), при необходимости `uploads`, и держать `.env.prod` в защищённом месте **вне сервера**.
3. **Диск:** `docker system df`; при нехватке — `docker builder prune -f`.
4. **TLS:** срок сертификата — `curl -vI https://<домен> 2>&1 | grep -i expire` (продление авто; алерт если < 14 дней).
5. **Дашборд `/metrics`** — резкое падение «% успеха» = регресс распознавания или Bitrix24/1С недоступен.

### Ежемесячно / по необходимости
- **Обновления приложения** — **автоматические**: зелёный CI в `main` → образ в GHCR → Watchtower (каждые 5 мин). Форс: `make prod-redeploy`.
- **Зависимости** (npm) приходят PR-ами (Dependabot) → ревью/мерж владельцем → CI → Watchtower.
- **Redis и базовые образы** — вручную, со снапшотом:
  ```bash
  docker exec procure-redis sh -c 'REDISCLI_AUTH=$REDIS_PASSWORD redis-cli save'
  docker compose -p procure-ai pull redis && docker compose -p procure-ai up -d redis
  ```
- **Ротация токенов** (при утечке/периодически) — генерировать `openssl rand -hex 32`, заменить в `.env.prod`, затем `make prod-redeploy`. Список токенов — [GUIDE_OWNER.md](GUIDE_OWNER.md).

## Частые команды
```bash
make prod-up         # поднять/обновить стек
make prod-redeploy   # форс-обновление образов сейчас
make logs            # хвост логов всех контейнеров
make metrics-reset   # сбросить только счётчики /metrics (после тестовых прогонов)
```

## Что важно помнить
- **Прод обязан использовать Redis** — без него задания не переживают рестарт (recovery нечего восстанавливать).
- **Деплой долго останавливает контейнер** — это норма: бэкенд дорабатывает текущий файл (graceful-drain до ~12 мин), что не успело — поднимет recovery при старте.
- **PHP-модуль Bitrix24** (`shef:purchase.api.*`) живёт **на портале**, не в Docker — обновляется **отдельно** (`make deploy-b24` / ручная выкладка), Watchtower его не катит.
- **Откат** — пин `APP_IMAGE_TAG`/`MCP_IMAGE_TAG` (sha-тег) в `.env.prod`; пошагово — [OPERATIONS.md §4](OPERATIONS.md).

## Куда смотреть при инциденте
On-call «алерт → действие», разбор по логам, откат — [`../mcp/docs/RUNBOOK.md`](../mcp/docs/RUNBOOK.md). Контакт эскалации — OPERATIONS §0.
