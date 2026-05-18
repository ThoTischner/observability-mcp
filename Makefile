.PHONY: help build up demo down logs test lint smoke clean release-dryrun

# Print every target with its leading-comment description.
help: ## Show this help
	@awk 'BEGIN{FS=":.*##"; printf "Targets:\n"} /^[a-zA-Z_-]+:.*##/ {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

##@ Stack

build: ## Build the mcp-server image
	docker compose build mcp-server

up: ## Start only mcp-server (point at external Prometheus/Loki)
	docker compose up -d mcp-server

demo: ## Full demo stack: mcp-server + Prometheus + Loki + example services + agent
	docker compose --profile demo up --build --wait

# One command, fully on-prem, zero external calls: starts the stack, injects
# a real incident, and shows raw-vs-analyzed side by side. KEEP_UP=1 to keep
# the stack running afterwards.
demo-sovereign: ## Sovereign quickstart: on-prem incident demo, raw vs analyzed
	./scripts/demo-sovereign.sh

down: ## Stop everything and remove volumes
	docker compose --profile demo down -v

logs: ## Tail mcp-server logs
	docker compose logs -f mcp-server

##@ Verification

# Unit tests run inside a throwaway node container so the host never needs npm.
test: ## Run mcp-server unit tests in Docker
	docker run --rm -w /app -v "$(PWD)/mcp-server:/app" node:20-alpine \
	  sh -c "npm install --silent --no-audit --no-fund && \
	         npx tsx --test src/analysis/*.test.ts src/config/*.test.ts src/sdk/*.test.ts"

lint: ## helm lint + tsc --noEmit
	docker run --rm -v "$(PWD)/helm:/apps" alpine/helm:3.16.2 lint /apps/observability-mcp
	docker run --rm -w /app -v "$(PWD)/mcp-server:/app" node:20-alpine \
	  sh -c "npm install --silent --no-audit --no-fund && npx tsc --noEmit"

# Proves the server boots and serves health with NO internet and NO sources
# configured — the "verifiable offline mode" guarantee, end to end.
test-offline: build ## Boot the image on an egress-blocked network and assert healthy
	./scripts/offline-boot-check.sh

# A faster local approximation of the CI smoke test. CI is authoritative
# (`.github/workflows/integration.yml`); this is for quick iteration.
smoke: demo ## Run the local smoke probe against the demo stack
	@echo "Waiting for /api/sources to report all up..."
	@for i in $$(seq 1 30); do \
	  body=$$(curl -fsS http://localhost:3000/api/sources 2>/dev/null || true); \
	  if [ -n "$$body" ]; then \
	    total=$$(echo "$$body" | jq 'length'); \
	    ok=$$(echo "$$body" | jq '[.[] | select(.status == "up")] | length'); \
	    if [ "$$total" -gt 0 ] && [ "$$total" = "$$ok" ]; then \
	      echo "all $$total sources connected"; exit 0; \
	    fi; \
	  fi; \
	  sleep 5; \
	done; \
	echo "sources never converged"; exit 1

##@ Release

release-dryrun: ## Print what the auto-release workflow would publish
	@echo "Current version: $$(jq -r .version mcp-server/package.json)"
	@echo "Last tag:        $$(git describe --tags --abbrev=0 2>/dev/null || echo none)"
	@echo "Commits since:   $$(git rev-list $$(git describe --tags --abbrev=0)..HEAD --count 2>/dev/null || echo all)"
	@echo
	@echo "To trigger an actual release: gh workflow run auto-release.yml"

clean: ## Stop the stack and prune dangling images
	docker compose --profile demo down -v
	docker image prune -f
