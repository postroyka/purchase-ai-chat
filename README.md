# Procure AI

Автоматическое создание сделок в Bitrix24 из прайс-листов поставщиков (PDF, XLSX, DOCX).

Пользователь загружает файл → агент на базе Claude Code извлекает данные → создаёт сделку в воронке «Закупки» (BYN, НДС 20%).

## Архитектура

```
UI (Nuxt, :3000) ──upload/poll──▶ backend (Express, :3000) ──Claude Code──▶ MCP (Nuxt, :3001)
                                                                              find_supplier
                                                                              find_contract
                                                                              find_product
                                                                              create_deal
```

## Быстрый старт

```bash
cp .env.prod.example .env.prod
# заполнить BACKEND_API_TOKEN, NUXT_MCP_AUTH_TOKEN, NUXT_BITRIX24_WEBHOOK_URL
docker compose -f docker-compose.prod.yml up --build
```

Открыть: http://localhost:3000

## Ключевые переменные окружения

| Переменная | Контейнер | Описание |
|---|---|---|
| `BACKEND_API_TOKEN` | app | Bearer-токен для /upload и /job/:id/status |
| `NUXT_MCP_AUTH_TOKEN` | mcp | Bearer-токен для MCP endpoint |
| `NUXT_BITRIX24_WEBHOOK_URL` | mcp | Webhook Bitrix24 с правами CRM |
| `PUBLIC_PAGE_RESPONSIBLE_USER_ID` | app | ID пользователя Б24 по умолчанию |
| `JOB_TTL_HOURS` | app | Время хранения завершённых задач (по умолчанию: 24) |

## Документация

- [docs/PROJECT_BRIEF.md](docs/PROJECT_BRIEF.md) — требования и бизнес-правила
- [prompts/main.md](prompts/main.md) — системный промпт агента
