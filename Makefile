# Ordo — common tasks. Run `make` or `make help` for the list.

COMPOSE      ?= docker compose
DEV_COMPOSE  ?= docker compose -f docker-compose.dev.yml
BACKUP_DIR   ?= backups
IMAGE_REPO   ?= git.imevul.com/haxnet/ordo

.DEFAULT_GOAL := help
.PHONY: help up down restart update logs ps status seed backup restore psql ensure-secret admin reset-password \
        publish dev dev-db dev-down install build test typecheck lint format db-generate check-bundle clean

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

# Adds ORDO_SECRET_KEY to .env when missing (new installs, and installs older than v0.2).
ensure-secret: .env
	@grep -qE '^ORDO_SECRET_KEY=.+' .env || { \
		key=$$(head -c 32 /dev/urandom | base64 | tr -d '\n'); \
		if grep -q '^ORDO_SECRET_KEY=' .env; then \
			sed -i.bak "s|^ORDO_SECRET_KEY=.*|ORDO_SECRET_KEY=$$key|" .env && rm -f .env.bak; \
		else \
			printf '\n# Encrypts stored secrets (SSO, integrations). Back it up together with your database.\nORDO_SECRET_KEY=%s\n' "$$key" >> .env; \
		fi; \
		echo "Added ORDO_SECRET_KEY to .env — keep a copy with your backups."; \
	}

up: .env ensure-secret ## Build and start Ordo in the background
	$(COMPOSE) up -d --build --wait
	@. ./.env; echo; echo "  Ordo is up → $${ORDO_PUBLIC_URL:-http://localhost:3000}"; echo

down: ## Stop Ordo (data is kept)
	$(COMPOSE) down

restart: ## Restart the running containers
	$(COMPOSE) restart
	@$(COMPOSE) ps

publish: ## Build and push git.imevul.com/haxnet/ordo:<git sha> and :latest
	@dirty=$$(git status --porcelain -- Dockerfile .dockerignore package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json apps packages); \
		if [ -n "$$dirty" ]; then \
			echo "Commit image inputs before publish so the tag matches what was built:" >&2; \
			printf '%s\n' "$$dirty" >&2; \
			exit 1; \
		fi
	@sha=$$(git rev-parse HEAD); \
		docker build -t $(IMAGE_REPO):$$sha -t $(IMAGE_REPO):latest . && \
		docker push $(IMAGE_REPO):$$sha && \
		docker push $(IMAGE_REPO):latest && \
		echo "Pushed $(IMAGE_REPO):$$sha"

update: .env ensure-secret ## Pull the latest code, rebuild and restart (migrations run on boot)
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

backup: ## Dump the database and uploads to backups/ordo-<timestamp>.*
	@mkdir -p $(BACKUP_DIR)
	@stamp=$$(date +%Y%m%d-%H%M%S); \
		$(COMPOSE) exec -T db sh -c 'pg_dump -U "$$POSTGRES_USER" -d "$$POSTGRES_DB" --clean --if-exists' | gzip > $(BACKUP_DIR)/ordo-$$stamp.sql.gz && \
		$(COMPOSE) exec -T app tar -C /data -czf - . > $(BACKUP_DIR)/ordo-$$stamp.uploads.tar.gz && \
		echo "Backup written to $(BACKUP_DIR)/ordo-$$stamp.{sql,uploads.tar}.gz"

restore: ## Restore a backup: make restore FILE=backups/ordo-….sql.gz (uploads too, if alongside)
	@test -n "$(FILE)" || (echo "Usage: make restore FILE=backups/ordo-….sql.gz" && exit 1)
	$(COMPOSE) stop app
	gunzip -c $(FILE) | $(COMPOSE) exec -T db sh -c 'psql -q -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"'
	@uploads=$$(echo $(FILE) | sed 's/\.sql\.gz$$/.uploads.tar.gz/'); \
		if [ -f "$$uploads" ]; then \
			$(COMPOSE) run --rm -T --no-deps --entrypoint sh app -c 'rm -rf /data/* && tar -C /data -xzf -' < "$$uploads" && echo "Restored uploads from $$uploads"; \
		fi
	$(COMPOSE) start app

admin: ## Make someone an instance admin: make admin EMAIL=you@example.com
	@test -n "$(EMAIL)" || (echo "Usage: make admin EMAIL=you@example.com" && exit 1)
	$(COMPOSE) exec app node cli.mjs promote-admin $(EMAIL)

reset-password: ## Print a password reset link: make reset-password EMAIL=…
	@test -n "$(EMAIL)" || (echo "Usage: make reset-password EMAIL=you@example.com" && exit 1)
	$(COMPOSE) exec app node cli.mjs reset-password $(EMAIL)

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

check-bundle: dev-db ## Build, then boot the API bundle without node_modules
	./scripts/check-bundle.sh

clean: ## Remove build output
	rm -rf apps/*/dist
