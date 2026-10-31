# Ordo — common tasks. Run `make` or `make help` for the list.

COMPOSE      ?= docker compose
DEV_COMPOSE  ?= docker compose -f docker-compose.dev.yml
BACKUP_DIR   ?= backups

# Your own settings (git-ignored), e.g. IMAGE_REPO := registry.example.com/you/ordo for `make publish`.
-include local.mk

.DEFAULT_GOAL := help
.PHONY: help up down restart update logs ps status seed backup restore psql ensure-secret check-proxy admin reset-password \
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

# Warns when Ordo believes X-Forwarded-For while published on every interface: anyone who can reach the port
# directly could then fake their IP (ENG-46). Old .env files copied from .env.example set ORDO_TRUST_PROXY=true.
check-proxy:
	@test -f .env || exit 0; \
		val() { sed -n "s/^$$1=//p" .env | tail -n 1 | sed 's/[[:space:]]#.*//' | tr -d "\"' \t" | tr 'A-Z' 'a-z'; }; \
		trust=$$(val ORDO_TRUST_PROXY); bind=$$(val ORDO_BIND); \
		case "$$trust" in ''|0|false|no|off) ;; *) \
			case "$${bind:-0.0.0.0}" in 0.0.0.0|::|'[::]') \
				echo; \
				echo "  Warning: .env has ORDO_TRUST_PROXY=$$trust while Ordo is published on all interfaces."; \
				echo "  Anyone who can reach the port directly can fake their IP (sign-in limits, audit log)."; \
				echo "  No reverse proxy? Set ORDO_TRUST_PROXY=false. Behind one? Set ORDO_BIND=127.0.0.1"; \
				echo "  or firewall the port. See docs/self-hosting.md#https-and-reverse-proxies."; \
				echo;; \
			esac;; \
		esac

up: .env ensure-secret ## Build and start Ordo in the background
	$(COMPOSE) up -d --build --wait
	@. ./.env; echo; echo "  Ordo is up → $${ORDO_PUBLIC_URL:-http://localhost:3000}"; echo
	@$(MAKE) --no-print-directory check-proxy

down: ## Stop Ordo (data is kept)
	$(COMPOSE) down

restart: ## Restart the running containers
	$(COMPOSE) restart
	@$(COMPOSE) ps

publish: ## Build and push $IMAGE_REPO:<git sha> and :latest (set it in local.mk)
	@if [ -z "$(IMAGE_REPO)" ]; then \
		echo "Set IMAGE_REPO first: in local.mk (IMAGE_REPO := registry.example.com/you/ordo) or make publish IMAGE_REPO=…" >&2; \
		exit 1; \
	fi
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
	@$(MAKE) --no-print-directory check-proxy

logs: ## Follow application logs
	$(COMPOSE) logs -f --tail=200 app

ps: ## Show container status
	$(COMPOSE) ps

status: ps

seed: ## Load the demo workspace (sign in as demo@ordo.test / ordo-demo-password)
	$(COMPOSE) exec app node seed.mjs

# Without pipefail a pipe's status is its last command's, so a failed pg_dump or gunzip would look like success.
# /bin/sh may be a dash without pipefail, so these two run under bash (.SHELLFLAGS needs make ≥ 3.82; macOS has 3.81).
backup restore: SHELL := bash

# Each file is written to *.tmp and renamed only once it's complete, so a failure never leaves a truncated backup.
backup: ## Dump the database and uploads to backups/ordo-<timestamp>.*
	@set -o pipefail; mkdir -p $(BACKUP_DIR); \
		base=$(BACKUP_DIR)/ordo-$$(date +%Y%m%d-%H%M%S); \
		trap 'rm -f "$$base.sql.gz.tmp" "$$base.uploads.tar.gz.tmp"' EXIT; \
		$(COMPOSE) exec -T db sh -c 'pg_dump -U "$$POSTGRES_USER" -d "$$POSTGRES_DB" --clean --if-exists' \
			| gzip > "$$base.sql.gz.tmp" && gzip -t "$$base.sql.gz.tmp" \
			|| { echo "Database dump failed; no backup written." >&2; exit 1; }; \
		$(COMPOSE) exec -T app tar -C /data -czf - . > "$$base.uploads.tar.gz.tmp" && gzip -t "$$base.uploads.tar.gz.tmp" \
			|| { echo "Uploads archive failed; no backup written." >&2; exit 1; }; \
		mv "$$base.sql.gz.tmp" "$$base.sql.gz" && mv "$$base.uploads.tar.gz.tmp" "$$base.uploads.tar.gz" && \
		echo "Backup written to $$base.{sql,uploads.tar}.gz"

restore: UPLOADS = $(patsubst %.sql.gz,%.uploads.tar.gz,$(FILE))

# Unpacks the archive on stdin into /data. It's extracted next to the old files first and swapped in only once tar
# succeeds, so a bad archive leaves the current uploads alone. /data is a volume, so it can't be renamed itself.
RESTORE_UPLOADS = d=/data; new=$$d/.restore-new; old=$$d/.restore-old; \
	rm -rf "$$new" "$$old" && mkdir "$$new" "$$old" && tar -C "$$new" -xzf - \
		|| { rm -rf "$$new" "$$old"; exit 1; }; \
	for f in "$$d"/* "$$d"/.[!.]* "$$d"/..?*; do \
		[ -e "$$f" ] && [ "$$f" != "$$new" ] && [ "$$f" != "$$old" ] || continue; \
		mv "$$f" "$$old"/ || { echo "Moving the old uploads aside failed; they are in $$d and $$old." >&2; exit 1; }; \
	done; \
	for f in "$$new"/* "$$new"/.[!.]* "$$new"/..?*; do \
		[ -e "$$f" ] || continue; \
		mv "$$f" "$$d"/ || { echo "Moving the restored uploads in failed; the old ones are in $$old." >&2; exit 1; }; \
	done; \
	rm -rf "$$new" "$$old"

# Both archives are checked before anything stops, psql runs as one transaction that stops at the first error, and the
# uploads are swapped in only once they're unpacked, so a bad backup leaves the old data in place. The app is started
# again however the restore ends.
restore: ## Restore a backup: make restore FILE=backups/ordo-….sql.gz (uploads too, if alongside)
	@test -n "$(FILE)" || (echo "Usage: make restore FILE=backups/ordo-….sql.gz" && exit 1)
	@test -f "$(FILE)" || (echo "No such file: $(FILE)" >&2 && exit 1)
	@gzip -t "$(FILE)" || (echo "$(FILE) is not a complete gzip file; nothing was restored." >&2 && exit 1)
	@if [ "$(UPLOADS)" != "$(FILE)" ] && [ -f "$(UPLOADS)" ]; then \
		gzip -t "$(UPLOADS)" && tar -tzf "$(UPLOADS)" >/dev/null \
			|| { echo "$(UPLOADS) is not a complete archive; nothing was restored." >&2; exit 1; }; \
	fi
	$(COMPOSE) stop app
	@set -o pipefail; trap '$(COMPOSE) start app' EXIT; \
		gunzip -c "$(FILE)" | $(COMPOSE) exec -T db sh -c \
			'psql -q -v ON_ERROR_STOP=1 --single-transaction -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"' \
		|| { echo "Restore failed; the database was rolled back and uploads were not touched." >&2; exit 1; }; \
		if [ "$(UPLOADS)" != "$(FILE)" ] && [ -f "$(UPLOADS)" ]; then \
			$(COMPOSE) run --rm -T --no-deps --entrypoint sh app -c '$(RESTORE_UPLOADS)' < "$(UPLOADS)" \
			|| { echo "Restoring uploads failed; the database was restored, the old uploads were kept." >&2; exit 1; }; \
			echo "Restored uploads from $(UPLOADS)"; \
		fi

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
