.PHONY: dev build up down logs shell-app shell-mcp clean

dev:
	cd backend && npm run dev &
	cd mcp && npm run start

build:
	docker compose -f docker-compose.prod.yml build

up:
	docker compose -f docker-compose.prod.yml up -d

down:
	docker compose -f docker-compose.prod.yml down

logs:
	docker compose -f docker-compose.prod.yml logs -f

shell-app:
	docker compose -f docker-compose.prod.yml exec app sh

shell-mcp:
	docker compose -f docker-compose.prod.yml exec mcp sh

clean:
	docker compose -f docker-compose.prod.yml down -v --rmi local
