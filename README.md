# Procure AI

Автоматическое создание сделок в Bitrix24 из прайс-листов поставщиков (PDF, XLSX, DOCX).

Пользователь загружает файл → агент на базе Claude Code извлекает данные → создаёт сделку в воронке «Закупки» (BYN, НДС 20%).

## Архитектура

```
                    dev: :3001          prod: :3000 (Express раздаёт UI-статику)
UI (Nuxt SPA) ──upload/poll──▶ backend (Express, :3000) ──Claude Code──▶ MCP (:3000, internal)
                                                                          b24_pst_crm_find_supplier
                                                                          b24_pst_crm_find_contract
                                                                          b24_pst_crm_find_product
                                                                          b24_pst_crm_create_deal
                                      ▲
                                      │
                                   Redis (jobs persistence)
```

- **Dev**: Nuxt dev-server на `:3001`, backend на `:3000`. devProxy в nuxt.config.ts перенаправляет `/upload`, `/job`, `/health` на backend.
- **Prod**: Nuxt собирается в статику (`ui/.output/public/`), Express раздаёт её через `express.static` — один процесс, один порт `:3000`.
- MCP не публикует порт наружу — доступен только внутри Docker-сети (`http://mcp:3000/mcp`).

## Быстрый старт

```bash
cp .env.prod.example .env.prod
# Обязательно заменить: BACKEND_API_TOKEN, NUXT_MCP_AUTH_TOKEN,
#                       NUXT_BITRIX24_WEBHOOK_URL, PUBLIC_PAGE_BASIC_AUTH_PASS,
#                       REDIS_PASSWORD (и скопировать его в REDIS_URL)
# Сгенерировать токены: openssl rand -hex 32

make prod-up   # pull образов из GHCR + docker compose up -d
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
| `CLAUDE_CODE_BIN` | app | — | Путь к бинарнику Claude Code CLI (по умолчанию: `claude` из PATH) |
| `AGENT_TIMEOUT_MS` | app | — | Таймаут запуска агента в мс (по умолчанию: 300000 = 5 мин) |
| `CLAUDE_MODEL` | app | — | Модель Claude для агента (по умолчанию из настроек claude CLI) |
| `MCP_SERVER_URL` | app | — | URL MCP-сервера (по умолчанию: `http://mcp:3000/mcp`) |

## Мониторинг задач (API)

**Linux / macOS (bash):**
```bash
BASE=http://localhost:3000
TOKEN=dev-token-local        # BACKEND_API_TOKEN из backend/.env.prod (или .env для локалки)

# Health (без токена) — проверяет связь с Redis
# → { "ok": true, "redis": "ok" }  или 503 { "ok": false, "redis": "unavailable" }
curl "$BASE/health"

# Загрузить файл
curl -X POST "$BASE/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -F "files[]=@invoice.pdf"
# → { "jobId": "uuid", "files": [{ "name": "invoice.pdf", "status": "pending" }] }

# Проверить статус
curl "$BASE/job/<jobId>/status" \
  -H "Authorization: Bearer $TOKEN"
# → { "jobId": "...", "status": "done", "files": [...] }
```

**Windows (PowerShell):**
```powershell
$BASE  = "http://localhost:3000"
$TOKEN = "dev-token-local"   # BACKEND_API_TOKEN из backend/.env.prod (или .env для локалки)

# Health (без токена) — проверяет связь с Redis
curl.exe -i "$BASE/health"

# Загрузить файл (поле обязательно files[], не file)
$json = curl.exe -s -X POST "$BASE/upload" `
  -H "Authorization: Bearer $TOKEN" `
  -F "files[]=@invoice.pdf;type=application/pdf"
$json
$jobId = ($json | ConvertFrom-Json).jobId

# Проверить статус
curl.exe -i -H "Authorization: Bearer $TOKEN" "$BASE/job/$jobId/status"
```

> ⚠️ В PowerShell используй `curl.exe` (не алиас `curl`), иначе синтаксис флагов другой.

## MCP — upstream и кастомные инструменты

`mcp/` подключён через **git subtree** из
[bitrix24/templates-mcp](https://github.com/bitrix24/templates-mcp) —
файлы хранятся прямо в репо, никаких submodule.

⚠️ **Статус Week 1:** все 4 PST-инструмента (`b24_pst_crm_*`) — заглушки. Сквозной флоу не работает до реализации Week 2 (b24-controller + тела инструментов).

PST-специфичные инструменты живут в `mcp-overlay/` и копируются поверх
upstream при сборке образа (`Dockerfile.mcp`). Имена используют префикс
`b24_pst_crm_*`, чтобы не пересекаться с `b24_crm_*` upstream.

**Добавить новый инструмент:**
1. Создать файл в `mcp-overlay/server/mcp/tools/<category>/<tool-name>.ts`
2. Использовать имя вида `b24_pst_<category>_<action>`
3. `Dockerfile.mcp` автоматически скопирует файл поверх upstream при следующем `docker build`

**Обновить upstream MCP:**
```bash
git subtree pull --prefix=mcp https://github.com/bitrix24/templates-mcp main --squash
```
После обновления убедиться, что overlay-файлы не конфликтуют с новыми файлами upstream.

**Откат образа на предыдущую версию:**
```bash
# На сервере — найти нужный sha-тег в GHCR и подставить в compose
# Пример: откат app на конкретный коммит
docker pull ghcr.io/postroyka/procure-ai-app:sha-<commit-sha>
# Отредактировать .env.prod: добавить IMAGE_TAG=sha-<commit-sha>
# Или напрямую в docker-compose.prod.yml заменить :latest на нужный тег
make prod-redeploy
```

## Разработка

Требуется **Node.js 22 LTS** с corepack:
```bash
node --version   # v22.x.x
corepack enable  # один раз
```

```bash
cd backend && pnpm install && pnpm dev   # :3000
cd mcp     && pnpm install && pnpm dev   # :3000 (internal)
cd ui      && pnpm install && pnpm dev   # :3001 (proxy /upload /job → backend :3000)
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

---

*Last reviewed: 2026-06-08 (PR #39 — fix stdin hang on claude CLI 2.x, filePath prompt-injection guard, output buffer cap, test coverage +3)*
