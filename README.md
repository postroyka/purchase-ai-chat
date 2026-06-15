# Procure AI

Автоматическое создание сделок в Bitrix24 из прайс-листов поставщиков (PDF, XLSX/XLS, DOCX, фото/скан).

Пользователь загружает файл → backend извлекает текст (PDF/изображения — OCR, office — python-хелпер) → агент на базе Claude Code извлекает данные из текста → создаёт сделку в воронке «Закупки» (BYN, НДС 20%).

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

- **Dev**: Nuxt dev-server на `:3001`, backend на `:3000`. devProxy в nuxt.config.ts перенаправляет `/upload`, `/job`, `/health`, `/metrics/data` на backend.
- **Prod**: Nuxt собирается в статику (`ui/.output/public/`); в образе она копируется в `ui/public/`, откуда Express раздаёт её через `express.static` — один процесс, один порт `:3000`.
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
| `BACKEND_API_TOKEN` | app | ✅ | Bearer для `/upload`, `/job/:id/status`, `/metrics/data`. **Серверный** — в браузер не попадает: UI авторизуется HTTP Basic (см. `PUBLIC_PAGE_BASIC_AUTH_*`), #41/#105 P1 |
| `REDIS_PASSWORD` | app/redis | ✅ | Пароль Redis (тот же подставляется в `REDIS_URL` в compose) |
| `NUXT_MCP_AUTH_TOKEN` | mcp | ✅ | Bearer-токен для `/mcp` endpoint |
| `NUXT_BITRIX24_WEBHOOK_URL` | mcp | ✅ | Вебхук Bitrix24: вызывает контроллеры `shef:purchase.api.procure*` + стандартные `crm.*` |
| `PUBLIC_PAGE_BASIC_AUTH_PASS` | app | ✅ | Пароль публичной страницы |
| `VIRTUAL_HOST` / `LETSENCRYPT_HOST` | app | ✅¹ | Домен приложения для nginx-proxy + acme |
| `LETSENCRYPT_EMAIL` | acme | ✅¹ | E-mail для Let's Encrypt (глобально в acme-companion) |
| `REDIS_URL` | app | — | URL Redis (в compose формируется из `REDIS_PASSWORD`) |
| `MCP_SERVER_URL` | app | — | URL MCP внутри сети (по умолчанию: `http://mcp:3000/mcp`) |
| `B24_DEAL_CATEGORY_ID` | mcp | — | Воронка сделок (по умолчанию: `1` «Закупки») |
| `B24_DEAL_DEFAULT_STAGE_ID` | mcp | — | Стадия сделки (по умолчанию: `C1:NEW`) |
| `PUBLIC_PAGE_ENABLED` | app | — | Включить публичную страницу (по умолчанию: `true`) |
| `PUBLIC_PAGE_BASIC_AUTH_USER` | app | — | Логин публичной страницы (по умолчанию: `procure`) |
| `PUBLIC_PAGE_RESPONSIBLE_USER_ID` | app | — | ID пользователя Б24 по умолчанию |
| `JOB_TTL_HOURS` | app | — | Время хранения задач в Redis (по умолчанию: 24) |
| `MAX_FILE_SIZE_MB` | app | — | Макс. размер файла (по умолчанию: 20) |
| `MAX_FILES_PER_REQUEST` | app | — | Макс. файлов в одном запросе (по умолчанию: 10) |
| `MAX_CONCURRENT_JOBS` | app | — | Лимит одновременных заданий; сверх — `429` (по умолчанию: `2` — с OCR не выше из-за RAM) |
| `ALLOWED_EXTENSIONS` | app | — | Разрешённые расширения (по умолчанию: `pdf,xlsx,docx,xls,jpg,jpeg,png`) |
| `OCR_LANGS` | app | — | Языки OCR (tesseract) для сканов/фото (по умолчанию: `rus+eng+bel`) |
| `RATE_LIMIT_MAX` | app | — | Лимит запросов `/upload` на токен в окне (по умолчанию: `20`, `0` = выкл.) |
| `RATE_LIMIT_WINDOW_MS` | app | — | Окно rate-limit в мс (по умолчанию: `60000`) |
| `HOURLY_RATE_BYN` | app | — | Стоимость часа сотрудника для оценки экономии на `/metrics` (по умолчанию: `18`; `0` = скрыть блок). Оценочное — уточнить с заказчиком |
| `MINUTES_PER_POSITION` | app | — | Ручное время на 1 позицию для оценки экономии (по умолчанию: `2`) |
| `USD_BYN_RATE` | app | — | **Фолбэк** курса USD→BYN (живой курс берётся из НБРБ `api.nbrb.by`, кэш 12 ч; фолбэк — при сбое). По умолчанию `3.3` |
| `CLAUDE_CODE_BIN` | app | — | Путь к бинарнику Claude Code CLI (по умолчанию: `claude` из PATH) |
| `AGENT_TIMEOUT_MS` | app | — | Таймаут запуска агента в мс (по умолчанию: 300000 = 5 мин) |
| `CLAUDE_MODEL` | app | — | Модель Claude для агента (по умолчанию из настроек claude CLI) |
| `ANTHROPIC_API_KEY` | app | ✅² | Ключ Claude API для агента. **В Docker обязателен** — подписка claude в контейнере не работает |
| `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` + `AWS_*` / `GOOGLE_*` | app | — | Альтернативные провайдеры Claude (Bedrock/Vertex) — пробрасываются агенту |
| `NODE_ENV` / `PORT` / `UPLOAD_DIR` | app | — | Стандартные настройки рантайма |

¹ Обязательны при деплое за общим nginx-proxy (прод). Для локального запуска не нужны.
² Обязателен для реальной работы агента. В Docker подписочная сессия `claude login` не работает, поэтому ключ задаётся явно в `.env.prod`. Локально (вне Docker) можно вместо него залогиниться интерактивно (`claude login`).

> **AI-провайдер.** Агент работает на **Claude Code** CLI (`CLAUDE_CODE_BIN`). Провайдер модели
> задаётся переменными окружения: Anthropic (`ANTHROPIC_API_KEY`) либо **DeepSeek**
> (`ANTHROPIC_BASE_URL` → `api.deepseek.com/anthropic`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`).
> В контейнере они задаются через `.env.prod` (проброшены allowlist `AGENT_ENV_KEYS`); для ручного
> CLI на хосте — через `~/.claude/settings.json` (см.
> [Установка Claude Code CLI на сервере](#установка-claude-code-cli-на-сервере-провайдер-deepseek)).
> Отдельные `DEEPSEEK_*` переменные из ТЗ/брифа в коде по-прежнему не задействованы.
>
> **Интеграция с Bitrix24** реализована REST-контроллерами в живом модуле коробки `shef.purchase`
> (исходники — папка `b24-controller/`, деплой `make deploy-b24`). Методы доступны как
> `shef:purchase.api.procure*`; MCP-сервер вызывает их через стандартный вебхук
> `NUXT_BITRIX24_WEBHOOK_URL` — никакого отдельного URL контроллера не нужно.

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

### Метрики использования (`/metrics`)

Дашборд «за всё время» с KPI-карточками и графиками: загрузки, форматы, доля OCR vs текстового
слоя, исходы обработки (включая `tool_unavailable` / `supplier_not_found`), стоимость прогонов модели и **экономика**.

- **Страница `/metrics`** — часть UI (Nuxt + b24ui), пункт сайдбара **«Метрики»** рядом с
  **«Загрузка счетов»**. Закрыта тем же **HTTP Basic**, что и весь UI (`PUBLIC_PAGE_BASIC_AUTH_*`).
  Локально (dev) — `http://localhost:3001/metrics`, в проде — `/metrics` того же origin.
- **`GET /metrics/data`** — JSON-срез для скриптов, принимает **Bearer-токен ИЛИ Basic**:

```bash
# BASE и TOKEN — как в блоке «Мониторинг задач (API)» выше
curl "$BASE/metrics/data" -H "Authorization: Bearer $TOKEN"   # либо Basic-логин страницы
```

Дашборд оценивает **экономию** (сэкономленное время × ставку − стоимость прогона модели) и
**потерю на позициях без артикула поставщика** (их нельзя автосопоставить). Курс **USD→BYN
берётся живым из НБРБ** (`api.nbrb.by`, кэш 12 ч). Источник курса виден на карточке и в поле
`usdBynSource`: `nbrb` — свежий курс НБРБ; `nbrb-stale` — последний успешный курс (НБРБ временно
недоступен); `env` — фолбэк на `USD_BYN_RATE` (НБРБ недоступен и кэша ещё нет). Остальные
параметры — `HOURLY_RATE_BYN`, `MINUTES_PER_POSITION` в `.env` (оценочные, уточнить с заказчиком;
`HOURLY_RATE_BYN=0` скрывает блок экономики).

> **Сеть.** Backend делает исходящий HTTPS-запрос к `api.nbrb.by` (раз в ~12 ч из-за кэша). За
> строгим egress-файрволом курс автоматически берётся из `USD_BYN_RATE`; при старте это видно в
> логах: `[backend] USD→BYN rate: … (source: env)`.

> **Обслуживание.** Счётчики копятся в Redis без TTL (lifetime) в ключах `metrics:*`; ключ
> `metrics:daily` растёт на одно поле в сутки. Сбросить все метрики (например, перед боевым
> запуском после тестов): `redis-cli --scan --pattern 'metrics:*' | xargs redis-cli del`. При
> восстановлении Redis из бэкапа метрики поднимаются вместе с журналом заданий.

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

✅ **Статус:** сквозной пайплайн реализован и проверен на живой коробке Bitrix24 — от приёма счёта (backend + агент, `backend/agent-runner.js`, спавн Claude Code CLI) до создания сделки через 4 PST-инструмента (`b24_pst_crm_*`) и REST-контроллеры `shef:purchase.api.procure*` (`b24-controller/`). Smoke-тест создания сделки (`scripts/smoke-test-b24.sh`, кейсы 4a/4b) — зелёный.

| Компонент | Статус |
| --- | --- |
| Приём счёта — backend `/upload` + OCR/office (`backend/`) | ✅ работает |
| Агент — Claude Code CLI, извлечение позиций (`backend/agent-runner.js`) | ✅ работает |
| MCP-инструменты `b24_pst_crm_*` (`mcp-overlay/`) | ✅ реализованы |
| REST-контроллеры `shef:purchase.api.procure*` (`b24-controller/`) | ✅ задеплоены, smoke зелёный |
| Дашборд `/metrics` (Nuxt + курс НБРБ) | ✅ работает |

> Этот блок — единый источник статуса фич. Обновляйте его в том же PR, что и фича.

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
# compose читает тег из ${APP_IMAGE_TAG:-latest} / ${MCP_IMAGE_TAG:-latest}.
# Закрепить нужный sha-тег из GHCR через .env.prod:
echo "APP_IMAGE_TAG=sha-<commit-sha>" >> .env.prod   # при необходимости и MCP_IMAGE_TAG
make prod-redeploy
# Watchtower будет держать закреплённый sha (он не двигается). Вернуть авто-обновление —
# убрать строку APP_IMAGE_TAG из .env.prod и снова `make prod-redeploy`.
```

## Разработка

Требуется **Node.js 22 LTS** с corepack:
```bash
node --version   # v22.x.x
corepack enable  # один раз
```

```bash
cd backend && pnpm install && pnpm dev              # :3000
cd mcp     && pnpm install && PORT=3002 pnpm dev     # :3002 (отдельно от backend :3000 и UI :3001)
cd ui      && pnpm install && pnpm dev               # :3001 (проксирует /upload /job → backend :3000)
```
> Backend ходит в MCP по `MCP_SERVER_URL` (см. `backend/.env.example` → `http://localhost:3002/mcp`).
> Для задач, не затрагивающих Б24, MCP локально можно не запускать (backend обращается к нему только на шаге создания сделки).

> Backend-агент запускает Claude Code CLI на **Linux, macOS и Windows**: на Windows
> `claude` — это `.cmd`-шим, поэтому агент находит его JS-точку входа и запускает через
> `node` (без shell — нет инъекции, нет лимита длины cmd.exe). Путь к бинарю можно
> переопределить `CLAUDE_CODE_BIN`; на Windows прописывать `.cmd` вручную не нужно.

## Тесты

```bash
cd backend && pnpm test           # vitest — upload, auth, jobs-store
cd mcp     && pnpm test           # vitest — инструменты, mcp-auth, naming
cd ui      && pnpm lint && pnpm build
```

## Деплой

Образы собираются GitHub Actions и публикуются в GHCR
(`ghcr.io/postroyka/procure-ai-app`, `…-mcp`). **Прод двигает только релизный тег**
(human-in-the-loop, #104 — зелёный CI ≠ «готово к проду», живой Б24 тестами не покрыт):

- **push в `main`** (после зелёного CI) → собирается только `sha-<sha>` —
  неизменяемый образ для отката; **прод не трогается**.
- **релизный тег `v*`** (`git tag v1.2.3 && git push origin v1.2.3`) → собираются
  `latest` + `v1.2.3` + `sha-<sha>`. Это и есть выкатка: на сервере **Watchtower**
  (опрос ~5 мин) подхватывает новый `latest` и пересоздаёт контейнеры за общим
  nginx-proxy.
- **ручной `workflow_dispatch`** — аварийный путь; публикует `latest`, но **только
  если CI на этом коммите зелёный** (раньше гейт можно было обойти).

Git на сервер не клонируется.

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
make init-nginxproxy       # ТОЛЬКО если nginx-proxy ещё не запущен (стек procure-proxy)
make prod-up               # запустить app + mcp + redis + watchtower (стек procure-ai)
```

> Приложение и прокси — **два изолированных compose-проекта** (`procure-ai` и
> `procure-proxy`), поэтому `--remove-orphans` в `prod-redeploy` не трогает
> nginx-proxy. Подробнее (и разовая миграция) — в `docs/SERVER_SETUP.md` §5.

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
>
> Альтернатива с проверкой целостности: `npm install -g @anthropic-ai/claude-code@2.1.168`
> (npm проверяет integrity по lockfile) — этот же способ используется в `Dockerfile.app`.
> При прямом скачивании бинарника сверьте контрольную сумму, если для релиза публикуется манифест.

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

> 🔒 Ограничьте доступ к файлу с ключом и не дайте ему попасть в git:
> ```bash
> chmod 600 ~/.claude/settings.json
> ```
> Если на сервере есть git-репозиторий, добавьте `.claude/` в `~/.gitignore_global`.

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
> операторских задач и ручной проверки. Прод-агент работает в контейнере `procure-app` со своим
> бинарником Claude Code и читает провайдера из переменных окружения, а не из хостового
> `~/.claude/settings.json`. Чтобы контейнер ходил в DeepSeek, задайте в `.env.prod`
> `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL` — они проброшены в агент через
> allowlist `AGENT_ENV_KEYS` (`backend/agent-runner.js`); см. блок «AI — Claude Code Agent» в `.env.prod.example`.

## Документация

- [docs/PROJECT_BRIEF.md](docs/PROJECT_BRIEF.md) — требования и бизнес-правила  
  *(Полное ТЗ — `docs/ТЗ_Закупки_PST.md` v1.10 — хранится в Google Drive проекта)*
- [prompts/main.md](prompts/main.md) — системный промпт агента

---

*Last reviewed: 2026-06-14 (PR #118 — #104: релиз-гейт деплоя (push в main → только `sha-<sha>`; тег `v*` → `:latest`; `workflow_dispatch` → `:latest` только при зелёном CI) + retry агента на транзиентные сбои провайдера (429/5xx/сеть/таймаут); issue #98 — синхронизация статуса фич в доках: 4 PST-инструмента реализованы, формулировки «заглушки/Week 2» убраны; PR #89 — рабочая REST-интеграция закупок: `shef:purchase.api.*` separator, by-ref `CCrmDeal::Update`/таймлайн, `BEGINDATE`/`documentDate`, гомоглиф-устойчивый и быстрый 1-в-1 поиск артикула/договора, кроссплатформенный smoke + эталонный счёт; PR #82 — `make deploy-images` (ручной деплой образов в GHCR без Actions); PR #81 — `workflow_dispatch` для Deploy; PR #79 — переезд дашборда `/metrics` на Nuxt/b24ui + живой курс USD→BYN из НБРБ (фолбэк `USD_BYN_RATE`); PR #78 — чеклист деплоя MCP ↔ PHP + CI-напоминание; PR #77 — `Shef\Purchase\Config`, централизация конфиг-параметров модуля; PR #74 — дашборд `/metrics` + lifetime-метрики пайплайна; PR #71 — REST-контроллеры `shef:purchase.api.procure*`, MCP deal tools, smoke-тесты, убран `B24_CONTRACTS_API_URL`; PR #53 — OCR + office, DOCUMENT_TEXT; PR #48 — basic-auth, DeepSeek; PR #47/#49)*
