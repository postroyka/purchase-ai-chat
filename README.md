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

## Разработка

```bash
cd backend && npm install && node index.js   # порт 3000
cd mcp     && pnpm install && pnpm dev       # порт 3001
cd ui      && pnpm install && pnpm dev       # порт 3000 (proxy → backend)
```

## Тесты

```bash
cd backend && npm test            # vitest — upload, auth, health
cd mcp     && pnpm test           # vitest — wire-coerce, v3-filter, mcp-auth
```

## Документация

- [docs/PROJECT_BRIEF.md](docs/PROJECT_BRIEF.md) — требования и бизнес-правила  
  *(Полное ТЗ — `docs/ТЗ_Закупки_PST.md` v1.10 — хранится в Google Drive проекта)*
- [prompts/main.md](prompts/main.md) — системный промпт агента
