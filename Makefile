.PHONY: dev logs shell-app shell-mcp \
	prod-up prod-down prod-redeploy prod-pull \
	init-network init-nginxproxy

# Shared reverse-proxy network name on the server (грабли #1).
PROXY_NET ?= proxy-net
# Explicit -p locks each stack to its own project (defence-in-depth alongside the
# `name:` field in each compose file) so `up --remove-orphans` can't cross stacks.
COMPOSE   := docker compose -p procure-ai -f docker-compose.prod.yml --env-file .env.prod
NGINX     := docker compose -p procure-proxy -f docker-compose.nginxproxy.yml --env-file .env.prod

# ---- local development ----
dev:
	cd backend && pnpm run dev &
	cd mcp && pnpm run dev

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
