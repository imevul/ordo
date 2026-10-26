# Ordo — common tasks. Run `make` or `make help` for the list.

COMPOSE      ?= docker compose
DEV_COMPOSE  ?= docker compose -f docker-compose.dev.yml
BACKUP_DIR   ?= backups

.DEFAULT_GOAL := help
.PHONY: help up down restart update logs ps status seed backup restore psql \
        dev dev-db dev-down install build test typecheck lint format db-generate clean

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "\n\033[1mOrdo\033[0m — make <target>\n\n"} \
		/^##@/ { printf "\n\033[38;5;198m%s\033[0m\n", substr($$0, 5) } \
		/^[a-zA-Z_-]+:.*##/ { printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@echo

##@ Self-hosting (Docker)

.env:
	@cp .env.example .env
	@pw=$$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32); \
		sed -i.bak "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$$pw/" .env && rm -f .env.bak
	@echo "Created .env with a random database password — review it before going public."

up: .env ## Build and start Ordo in the background
	$(COMPOSE) up -d --build --wait
	@. ./.env; echo; echo "  Ordo is up → $${ORDO_PUBLIC_URL:-http://localhost:3000}"; echo

down: ## Stop Ordo (data is kept)
	$(COMPOSE) down

restart: ## Restart the running containers
	$(COMPOSE) restart
	@$(COMPOSE) ps

update: .env ## Pull the latest code, rebuild and restart (migrations run on boot)
	@if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && git remote | grep -q .; then \
		git pull --ff-only; \
	else \
		echo "No git remote configured — rebuilding the current checkout."; \
	fi
	$(COMPOSE) build --pull
	$(COMPOSE) up -d --wait
	@docker image prune -f >/dev/null
	@echo "Updated."

logs: ## Follow application logs
	$(COMPOSE) logs -f --tail=200 app

ps: ## Show container status
	$(COMPOSE) ps

status: ps

seed: ## Load the demo workspace (sign in as demo@ordo.test / ordo-demo-password)
	$(COMPOSE) exec app node seed.mjs

backup: ## Dump the database to backups/ordo-<timestamp>.sql.gz
	@mkdir -p $(BACKUP_DIR)
	@file=$(BACKUP_DIR)/ordo-$$(date +%Y%m%d-%H%M%S).sql.gz; \
		$(COMPOSE) exec -T db sh -c 'pg_dump -U "$$POSTGRES_USER" -d "$$POSTGRES_DB" --clean --if-exists' | gzip > $$file && \
		echo "Backup written to $$file"

restore: ## Restore a backup: make restore FILE=backups/ordo-….sql.gz
	@test -n "$(FILE)" || (echo "Usage: make restore FILE=backups/ordo-….sql.gz" && exit 1)
	$(COMPOSE) stop app
	gunzip -c $(FILE) | $(COMPOSE) exec -T db sh -c 'psql -q -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"'
	$(COMPOSE) start app

psql: ## Open a psql shell in the database container
	$(COMPOSE) exec db sh -c 'psql -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"'

##@ Development

install: ## Install dependencies
	pnpm install

dev-db: ## Start only the development database (port 5433)
	$(DEV_COMPOSE) up -d --wait

dev: install dev-db ## Run API (:3001) and web (:5173) with hot reload
	pnpm dev

dev-down: ## Stop the development database
	$(DEV_COMPOSE) down

build: ## Build web and API bundles
	pnpm build

test: dev-db ## Run all tests (needs the dev database)
	pnpm test

typecheck: ## Typecheck every package
	pnpm typecheck

lint: ## Lint and check formatting
	pnpm lint

format: ## Apply formatting and safe lint fixes
	pnpm format

db-generate: ## Generate a migration after editing apps/api/src/db/schema.ts
	pnpm db:generate

clean: ## Remove build output
	rm -rf apps/*/dist
