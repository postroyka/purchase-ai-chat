# Procure AI

Автоматическое создание сделок в Bitrix24 из прайс-листов поставщиков (PDF, XLSX, DOCX).

Пользователь загружает файл → агент на базе Claude Code извлекает данные → создаёт сделку в воронке «Закупки» (BYN, НДС 20%).

## Архитектура

```
UI (Nuxt, :3000) ──upload/poll──▶ backend (Express, :3000) ──Claude Code──▶ MCP (Nuxt, :3000)
                                                                              find_supplier
                                                                              find_contract
                                                                              find_product
                                                                              create_deal
                                        ▲
                                        │
                                     Redis (jobs persistence)
```

MCP-сервис не публикует порт наружу — доступен только внутри Docker-сети (`http://mcp:3000/mcp`).

## Быстрый старт

```bash
cp .env.prod.example .env.prod
# Обязательно заменить: BACKEND_API_TOKEN, NUXT_MCP_AUTH_TOKEN,
#                       NUXT_BITRIX24_WEBHOOK_URL, PUBLIC_PAGE_BASIC_AUTH_PASS
# Сгенерировать токены: openssl rand -hex 32

docker compose -f docker-compose.prod.yml up --build
```

Открыть: http://localhost:3000

## Переменные окружения

| Переменная | Контейнер | Обязательно | Описание |
|---|---|---|---|
| `BACKEND_API_TOKEN` | app | ✅ | Bearer-токен для `/upload` и `/job/:id/status` |
| `NUXT_MCP_AUTH_TOKEN` | mcp | ✅ | Bearer-токен для `/mcp` endpoint |
| `NUXT_BITRIX24_WEBHOOK_URL` | mcp | ✅ | Webhook Bitrix24 с правами CRM |
| `PUBLIC_PAGE_BASIC_AUTH_PASS` | app | ✅ | Пароль публичной страницы |
| `REDIS_URL` | app | — | URL Redis (по умолчанию: `redis://redis:6379`) |
| `PUBLIC_PAGE_RESPONSIBLE_USER_ID` | app | — | ID пользователя Б24 по умолчанию |
| `JOB_TTL_HOURS` | app | — | Время хранения задач в Redis (по умолчанию: 24) |
| `MAX_FILE_SIZE_MB` | app | — | Макс. размер файла (по умолчанию: 20) |
| `MAX_FILES_PER_REQUEST` | app | — | Макс. файлов в одном запросе (по умолчанию: 10) |

## Мониторинг задач (API)

```bash
# Загрузить файл
curl -X POST http://localhost:3000/upload \
  -H "Authorization: Bearer $BACKEND_API_TOKEN" \
  -F "files[]=@invoice.pdf"
# → { "jobId": "uuid", "files": [{ "name": "invoice.pdf", "status": "pending" }] }

# Проверить статус
curl http://localhost:3000/job/<jobId>/status \
  -H "Authorization: Bearer $BACKEND_API_TOKEN"
# → { "jobId": "...", "status": "done", "files": [...] }
```

## MCP — upstream и кастомные инструменты

`mcp/` подключён через **git subtree** из
[bitrix24/templates-mcp](https://github.com/bitrix24/templates-mcp) —
файлы хранятся прямо в репо, никаких submodule.

PST-специфичные инструменты живут в `mcp-overlay/` и копируются поверх
upstream при сборке образа (`Dockerfile.mcp`). Имена инструментов используют
префикс `b24_pst_crm_*`, чтобы не пересекаться с возможными
`b24_crm_*`-инструментами upstream.

**Обновить upstream MCP:**
```bash
git subtree pull --prefix=mcp https://github.com/bitrix24/templates-mcp main --squash
```

## Разработка

```bash
cd backend && pnpm install && pnpm dev   # порт 3000
cd mcp     && pnpm install && pnpm dev    # порт 3000
cd ui      && pnpm install && pnpm dev    # порт 3000 (proxy → backend)
```

## Тесты

```bash
cd backend && pnpm test           # vitest — upload, auth, jobs-store
cd mcp     && pnpm test           # vitest — инструменты, mcp-auth, naming
cd ui      && pnpm lint && pnpm build
```

## Деплой

Образы собираются GitHub Actions при push в `main` и публикуются в
GHCR (`ghcr.io/postroyka/procure-ai-app`, `…-mcp`) с тегами
`latest` + `sha-<sha>`. На сервере **Watchtower** (опрос ~5 мин)
подхватывает новый `latest` и пересоздаёт контейнеры за общим
nginx-proxy. Git на сервер не клонируется.

**Разовая настройка сервера:**

```bash
mkdir -p /home/<user>/procure-ai && cd $_
BASE="https://raw.githubusercontent.com/postroyka/purchase-ai-chat/main"
for f in docker-compose.prod.yml docker-compose.nginxproxy.yml Makefile .env.prod.example; do
  curl -fsSLO "$BASE/$f"
done
cp .env.prod.example .env.prod && nano .env.prod   # заполнить секреты и домен

# Приватный GHCR — авторизоваться один раз (PAT с read:packages):
echo "$GHCR_PAT" | docker login ghcr.io -u <github-user> --password-stdin

make init-network          # создать сеть proxy-net
make init-nginxproxy       # ТОЛЬКО если nginx-proxy ещё не запущен на сервере
make prod-up               # запустить app + mcp + redis + watchtower
```

Обновление файлов на сервере — тем же `curl -fsSLO`, без `git pull`.
Принудительный редеплой без ожидания Watchtower — `make prod-redeploy`.

## Документация

- [docs/PROJECT_BRIEF.md](docs/PROJECT_BRIEF.md) — требования и бизнес-правила  
  *(Полное ТЗ — `docs/ТЗ_Закупки_PST.md` v1.10 — хранится в Google Drive проекта)*
- [prompts/main.md](prompts/main.md) — системный промпт агента
