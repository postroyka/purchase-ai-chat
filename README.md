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
| `REDIS_PASSWORD` | app/redis | ✅ | Пароль Redis (тот же подставляется в `REDIS_URL` в compose) |
| `NUXT_MCP_AUTH_TOKEN` | mcp | ✅ | Bearer-токен для `/mcp` endpoint |
| `NUXT_BITRIX24_WEBHOOK_URL` | mcp | ✅ | Webhook Bitrix24 с правами CRM |
| `PUBLIC_PAGE_BASIC_AUTH_PASS` | app | ✅ | Пароль публичной страницы |
| `VIRTUAL_HOST` / `LETSENCRYPT_HOST` | app | ✅¹ | Домен приложения для nginx-proxy + acme |
| `LETSENCRYPT_EMAIL` | acme | ✅¹ | E-mail для Let's Encrypt (глобально в acme-companion) |
| `REDIS_URL` | app | — | URL Redis (в compose формируется из `REDIS_PASSWORD`) |
| `MCP_SERVER_URL` | app | — | URL MCP внутри сети (по умолчанию: `http://mcp:3000/mcp`) |
| `B24_DEAL_CATEGORY_ID` | mcp | — | Воронка сделок (по умолчанию: `1` «Закупки») |
| `B24_DEAL_DEFAULT_STAGE_ID` | mcp | — | Стадия сделки (по умолчанию: `C1:NEW`) |
| `B24_CONTRACTS_API_URL` | mcp | — | URL внешнего REST-контроллера договоров (см. ниже) |
| `PUBLIC_PAGE_ENABLED` | app | — | Включить публичную страницу (по умолчанию: `true`) |
| `PUBLIC_PAGE_BASIC_AUTH_USER` | app | — | Логин публичной страницы (по умолчанию: `procure`) |
| `PUBLIC_PAGE_RESPONSIBLE_USER_ID` | app | — | ID пользователя Б24 по умолчанию |
| `JOB_TTL_HOURS` | app | — | Время хранения задач в Redis (по умолчанию: 24) |
| `MAX_FILE_SIZE_MB` | app | — | Макс. размер файла (по умолчанию: 20) |
| `MAX_FILES_PER_REQUEST` | app | — | Макс. файлов в одном запросе (по умолчанию: 10) |
| `ALLOWED_EXTENSIONS` | app | — | Разрешённые расширения (по умолчанию: `pdf,xlsx,docx`) |
| `CLAUDE_CODE_BIN` | app | — | Путь к бинарнику Claude Code CLI (по умолчанию: `claude` из PATH) |
| `AGENT_TIMEOUT_MS` | app | — | Таймаут запуска агента в мс (по умолчанию: 300000 = 5 мин) |
| `CLAUDE_MODEL` | app | — | Модель Claude для агента (по умолчанию из настроек claude CLI) |
| `ANTHROPIC_API_KEY` | app | ✅² | Ключ Claude API для агента (можно задать и через `~/.anthropic`) |
| `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` + `AWS_*` / `GOOGLE_*` | app | — | Альтернативные провайдеры Claude (Bedrock/Vertex) — пробрасываются агенту |
| `NODE_ENV` / `PORT` / `UPLOAD_DIR` | app | — | Стандартные настройки рантайма |

¹ Обязательны при деплое за общим nginx-proxy (прод). Для локального запуска не нужны.
² Обязателен для реальной работы агента; в `.env.prod.example` вынесен в комментарий (передаётся через `~/.anthropic` или env).

> **AI-провайдер.** Агент работает на **Claude Code** CLI (`CLAUDE_CODE_BIN`). Провайдер модели
> задаётся настройками Claude Code: по умолчанию Anthropic (`ANTHROPIC_API_KEY`), на сервере CLI
> переключён на **DeepSeek** через `~/.claude/settings.json` (`ANTHROPIC_BASE_URL` →
> `api.deepseek.com/anthropic`) — см. [Установка Claude Code CLI на сервере](#установка-claude-code-cli-на-сервере-провайдер-deepseek).
> Отдельные `DEEPSEEK_*` переменные из ТЗ/брифа в коде по-прежнему не задействованы.
>
> **`B24_CONTRACTS_API_URL` (поиск договоров)** указывает на **внешний** REST-контроллер
> на стороне Bitrix24 BUS — это не каталог в этом репозитории, а отдельный сервис заказчика.

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

> ⚠️ **Документация внутри `mcp/` (`mcp/docs/*`, `mcp/skills/*`) — это upstream
> templates-mcp**, она описывает образ `bx24-template-mcp` и его команды
> (`make up/redeploy`, теги `v*`, путь `/opt/bx24-template-mcp`). Для **procure-ai**
> это неверные инструкции — ориентируйтесь на корневой `README.md`, `Makefile`
> (`make prod-up`/`prod-redeploy`) и `docs/SERVER_SETUP.md`. Кастомные инструменты
> добавляются в `mcp-overlay/`, а не в `mcp/server/...` (иначе потеряются при subtree pull).

⚠️ **Статус:** backend и агент (`backend/agent-runner.js`, спавн Claude Code CLI) реализованы — сквозной прогон работает **до MCP-слоя**. Заглушками остались только 4 PST-инструмента (`b24_pst_crm_*`): они бросают «not implemented (Week 2)», поэтому сделки в Б24 пока не создаются (нужны тела инструментов + внешний b24-controller).

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

### Установка Claude Code CLI на сервере (провайдер DeepSeek)

Агент (`backend/agent-runner.js`) запускает **Claude Code CLI** (`CLAUDE_CODE_BIN`, по умолчанию
`claude` из `PATH`). На сервере CLI ставится нативным бинарником и переключается на провайдера
**DeepSeek** через `~/.claude/settings.json` (Anthropic-совместимый endpoint).

**1. Установка бинарника** (Ubuntu, `linux-x64`):

```bash
BUCKET="https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases"
VER=$(curl -fsSL "$BUCKET/latest")
mkdir -p ~/.local/bin
curl -fsSL -o ~/.local/bin/claude "$BUCKET/$VER/linux-x64/claude"
chmod +x ~/.local/bin/claude
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
claude --version   # → 2.1.168 (Claude Code)
```

> Для ARM-сервера замените `linux-x64` на `linux-arm64`. Папку `~/.local/bin` установщик
> мог создать сам — `mkdir -p` оставлен на всякий случай.

**2. Конфиг `~/.claude/settings.json`** (папку `~/.claude` мог создать установщик — `mkdir -p` подстрахует):

```bash
mkdir -p ~/.claude
cat > ~/.claude/settings.json << 'EOF'
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "ВСТАВЬ_СЮДА_СВОЙ_DEEPSEEK_КЛЮЧ",
    "ANTHROPIC_MODEL": "deepseek-v4-pro[1m]",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4-pro[1m]",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4-pro[1m]",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4-flash",
    "CLAUDE_CODE_SUBAGENT_MODEL": "deepseek-v4-flash",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_EFFORT_LEVEL": "max"
  }
}
EOF
```

> ⚠️ Кавычки вокруг `'EOF'` (одинарные) обязательны — иначе шелл попытается раскрыть
> `$`-символы и скобки внутри. После создания вставьте реальный ключ вместо
> `ВСТАВЬ_СЮДА_СВОЙ_DEEPSEEK_КЛЮЧ` (например, `nano ~/.claude/settings.json`); ключ берётся
> на platform.deepseek.com. **Реальный ключ не коммитить** — он живёт только на сервере.

Проверка валидности JSON (распечаталось без ошибки → формат ок):

```bash
cat ~/.claude/settings.json | python3 -m json.tool
```

**3. Проверка связки.** Быстрый headless-тест — сразу видно, доходит ли запрос до DeepSeek:

```bash
claude -p "ответь одним словом: работает"
```

Пришёл текст — связка живая. `401/403` — неверный ключ; таймаут — сервер не достаёт
`api.deepseek.com`. Дальше интерактивно:

```bash
claude
```

Внутри сессии выполнить `/status` и проверить два поля: `base URL` = `api.deepseek.com/anthropic`,
модель = `deepseek-v4-pro[1m]`. Если осталось что-то Anthropic'овское — `settings.json` не
подхватился (проверьте путь и валидность JSON).

> При первом запуске `claude` может предложить логин/онбординг через браузер. Поскольку
> `ANTHROPIC_AUTH_TOKEN` задан, OAuth не нужен — пропускайте (Esc / «уже есть ключ»), CLI
> работает по токену из конфига.

> ⚠️ **Хост vs контейнер.** Шаги выше настраивают `claude` CLI на самом сервере (хосте) — для
> операторских задач и ручной проверки. Контейнер `procure-app` запускает собственный бинарник
> Claude Code из образа с урезанным окружением (allowlist `AGENT_ENV_KEYS` в
> `backend/agent-runner.js` не пробрасывает `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`), поэтому
> хостовый `~/.claude/settings.json` на него автоматически не влияет. Чтобы и агент в контейнере
> ходил в DeepSeek, конфиг нужно доставить внутрь контейнера (смонтировать `~/.claude` или встроить
> в образ) — задавать `ANTHROPIC_BASE_URL` через `.env.prod` недостаточно, его отфильтрует allowlist.

## Документация

- [docs/PROJECT_BRIEF.md](docs/PROJECT_BRIEF.md) — требования и бизнес-правила  
  *(Полное ТЗ — `docs/ТЗ_Закупки_PST.md` v1.10 — хранится в Google Drive проекта)*
- [prompts/main.md](prompts/main.md) — системный промпт агента

---

*Last reviewed: 2026-06-08 (PR #39 — fix stdin hang on claude CLI 2.x, filePath prompt-injection guard, output buffer cap, test coverage +3)*
