.PHONY: dev logs shell-app shell-mcp \
	prod-up prod-down prod-redeploy prod-pull \
	init-network init-nginxproxy \
	deploy-b24 deploy-images ui-smoke check-agent-stdin eval eval-baseline eval-test

# Shared reverse-proxy network name on the server (грабли #1).
PROXY_NET ?= proxy-net
# Explicit -p locks each stack to its own project (defence-in-depth alongside the
# `name:` field in each compose file) so `up --remove-orphans` can't cross stacks.
COMPOSE   := docker compose -p procure-ai -f docker-compose.prod.yml --env-file .env.prod
NGINX     := docker compose -p procure-proxy -f docker-compose.nginxproxy.yml --env-file .env.prod
# Изолированный eval-стек (#93): свой проект, чтобы не пересекаться с боевым procure-ai.
EVAL      := docker compose -p procure-eval -f docker-compose.eval.yml --env-file .env.prod

# ---- local development ----
dev:
	cd backend && pnpm run dev &
	cd mcp && pnpm run dev

# ---- b24-controller (semi-manual SSH deploy) ----
# Выкладывает только procure*.php в живой модуль shef.purchase. По умолчанию
# dry-run; реальная выкладка: make deploy-b24 APPLY=1
deploy-b24:
	APPLY=$(APPLY) ./scripts/deploy-b24-controller.sh

# ---- ручной деплой образов в GHCR без GitHub Actions (путь B) ----
# Сборка + пуш образов app & mcp в ghcr.io, минуя Actions (полезно, когда раннеры/квота
# Actions недоступны). Нужен Docker + PAT: GHCR_TOKEN=ghp_xxx make deploy-images
deploy-images:
	bash ./scripts/deploy-images.sh

# ---- UI-смоук: ESLint + nuxt typecheck без полной сборки ----
ui-smoke:
	bash ./scripts/ui-smoke.sh

# ---- Регрессия #58: claude --print читает промпт из stdin (E2BIG-фикс) ----
check-agent-stdin:
	bash ./scripts/check-agent-stdin.sh

# ---- Eval-набор агента (#93): прогон по фикстурам со сверкой полей ----
# Нужен рабочий агент: claude CLI + ключ модели + доступный MCP + извлечение текста
# (pdftotext/OCR). НЕ для CI (платный вызов модели на фикстуру). Логика скоринга —
# в backend/tests/eval-score.test.js. Подробности: backend/eval/README.md
eval:
	node backend/eval/run.js

# ---- Baseline-черновики (#93): прогнать агента по счетам БЕЗ эталона и записать черновики
# <name>.expected.json из вывода агента (потом сверить с документом и поправить руками).
# То же живое окружение, что и eval. Подробности: backend/eval/README.md
eval-baseline:
	node backend/eval/baseline.js

# ---- Безопасный прогон eval на реальных счетах в ТЕСТОВЫЙ Bitrix24 (#93) ----
# Изолированный стек (docker-compose.eval.yml): отдельный MCP на тест-вебхуке
# (NUXT_BITRIX24_TEST_WEBHOOK_URL) + baseline. Боевой портал/контейнеры НЕ трогает — сделки
# идут в тест-портал. Счета — в scripts/samples/. Подробности: backend/eval/README.md
eval-test:
	-$(EVAL) run --rm eval
	$(EVAL) down

# ---- production (on the server) ----
# Pull latest images from GHCR and (re)create containers.
prod-up:
	$(COMPOSE) pull
	$(COMPOSE) up -d --remove-orphans

prod-down:
	$(COMPOSE) down

# Force an immediate redeploy without waiting for the Watchtower interval.
prod-redeploy:
	$(COMPOSE) pull
	$(COMPOSE) up -d --force-recreate --remove-orphans
	docker image prune -f

prod-pull:
	$(COMPOSE) pull

logs:
	$(COMPOSE) logs -f

shell-app:
	$(COMPOSE) exec app sh

shell-mcp:
	$(COMPOSE) exec mcp sh

# ---- one-time server setup ----
# Create the shared proxy network (idempotent).
init-network:
	docker network inspect $(PROXY_NET) >/dev/null 2>&1 || docker network create $(PROXY_NET)

# Bring up nginx-proxy + acme-companion — ONLY if not already running (грабли).
init-nginxproxy: init-network
	$(NGINX) up -d
