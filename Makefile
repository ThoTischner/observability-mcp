.PHONY: help build up demo demo-oidc demo-opa down logs test lint smoke ui-smoke clean release-dryrun benchmark-up benchmark-down benchmark-run benchmark-deps connect-claude-code connect-cursor doctor

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

demo-opa: ## OPA demo: Open Policy Agent + OPA-backed mcp-server (port 3002)
	@echo "==> Booting OPA + OPA-flavored mcp-server"
	docker compose --profile opa up --build --wait
	@echo
	@echo "OPA demo ready:"
	@echo "  UI:        http://localhost:3002/   (Policies tab → engine: opa:http://opa:8181)"
	@echo "  OPA:       http://localhost:8181/v1/data/observability/authz"
	@echo "  Policy:    examples/opa/policy.rego  (mounted read-only)"
	@echo
	@echo "Tear down with: docker compose --profile opa down"

demo-oidc: ## OIDC demo: Keycloak + mcp-server in OMCP_AUTH=oidc mode (port 3001)
	@echo "==> Booting Keycloak + OIDC-flavored mcp-server"
	docker compose --profile auth up --build --wait
	@echo
	@echo "OIDC demo ready:"
	@echo "  UI:         http://localhost:3001/   ('Sign in with SSO')"
	@echo "  Keycloak:   http://localhost:8088/   (keycloak / keycloak)"
	@echo "  Realm:      omcp-demo"
	@echo
	@echo "Demo users (passwords match username; DEMO ONLY):"
	@echo "  admin      → group omcp-admin    → OMCP role admin"
	@echo "  operator   → group omcp-ops      → OMCP role operator"
	@echo "  viewer     → group omcp-viewers  → OMCP role viewer"
	@echo
	@echo "Tear down with: docker compose --profile auth down"

# One command, fully on-prem, zero external calls: starts the stack, injects
# a real incident, and shows raw-vs-analyzed side by side. KEEP_UP=1 to keep
# the stack running afterwards.
demo-sovereign: ## Sovereign quickstart: on-prem incident demo, raw vs analyzed
	./scripts/demo-sovereign.sh

down: ## Stop everything and remove volumes
	docker compose --profile demo down -v

logs: ## Tail mcp-server logs
	docker compose logs -f mcp-server

##@ Connect from your agent

# Host + port the running mcp-server is reachable at. Override with
#   OMCP_HOST=mcp.internal OMCP_PORT=4444 make connect-claude-code
# if you've remapped the compose service or are running it behind a proxy.
OMCP_HOST ?= localhost
OMCP_PORT ?= 3000

connect-claude-code: ## Print the .mcp.json snippet for Claude Code / Claude Desktop
	@echo "# Paste into the 'mcpServers' object of your Claude config"
	@echo "# (Claude Code: claude mcp add observability --transport http http://$(OMCP_HOST):$(OMCP_PORT)/mcp)"
	@echo "# (Claude Desktop: ~/.config/Claude/claude_desktop_config.json on Linux,"
	@echo "#  ~/Library/Application Support/Claude/claude_desktop_config.json on macOS)"
	@echo "# If the server has OMCP_API_KEYS set, add a Bearer header to the"
	@echo "# transport block: \"headers\": { \"Authorization\": \"Bearer <key>\" }"
	@echo ""
	@echo '{'
	@echo '  "mcpServers": {'
	@echo '    "observability": {'
	@echo '      "transport": { "type": "http", "url": "http://$(OMCP_HOST):$(OMCP_PORT)/mcp" }'
	@echo '    }'
	@echo '  }'
	@echo '}'

connect-cursor: ## Print the MCP config snippet for Cursor
	@echo "# Drop into ~/.cursor/mcp.json (create the file if it doesn't exist)"
	@echo "# If the server has OMCP_API_KEYS set, add a Bearer header — see"
	@echo "# the commented \"headers\" block below."
	@echo ""
	@echo '{'
	@echo '  "mcpServers": {'
	@echo '    "observability": {'
	@echo '      "url": "http://$(OMCP_HOST):$(OMCP_PORT)/mcp"'
	@echo '      // "headers": { "Authorization": "Bearer <your-api-key>" }'
	@echo '    }'
	@echo '  }'
	@echo '}'

doctor: ## Quick health check — is the mcp-server reachable on $$OMCP_HOST:$$OMCP_PORT?
	@printf "Probing http://$(OMCP_HOST):$(OMCP_PORT)/healthz ... "
	@if curl -fsS --max-time 3 "http://$(OMCP_HOST):$(OMCP_PORT)/healthz" >/dev/null; then \
	  echo "ok"; \
	else \
	  echo "FAIL — is the stack up? Try: make demo"; exit 1; \
	fi
	@printf "Probing MCP handshake on /mcp ... "
	@if curl -fsS --max-time 5 -X POST "http://$(OMCP_HOST):$(OMCP_PORT)/mcp" \
	  -H "Content-Type: application/json" \
	  -H "Accept: application/json, text/event-stream" \
	  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"omcp-doctor","version":"1.0"}}}' \
	  | grep -q '"serverInfo"'; then \
	  echo "ok"; \
	else \
	  echo "FAIL — server is up but MCP handshake did not return serverInfo"; exit 1; \
	fi
	@printf "Probing /api/me identity discovery ... "
	@me=$$(curl -fsS --max-time 3 "http://$(OMCP_HOST):$(OMCP_PORT)/api/me" 2>/dev/null || echo ''); \
	if [ -z "$$me" ]; then \
	  echo "FAIL — endpoint missing (older server build?)"; \
	else \
	  mode=$$(echo "$$me" | jq -r '.mode // "?"'); \
	  auth=$$(echo "$$me" | jq -r '.authenticated // false'); \
	  echo "ok (mode=$$mode authenticated=$$auth)"; \
	fi
	@printf "Probing /api/info governance posture ... "
	@info=$$(curl -fsS --max-time 3 "http://$(OMCP_HOST):$(OMCP_PORT)/api/info" 2>/dev/null || echo ''); \
	if [ -z "$$info" ]; then \
	  echo "FAIL — endpoint missing (older server build?)"; \
	else \
	  authMode=$$(echo "$$info" | jq -r '.governance.authMode // "?"'); \
	  redaction=$$(echo "$$info" | jq -r '.governance.redaction // false'); \
	  auditPersisted=$$(echo "$$info" | jq -r '.governance.auditPersisted // false'); \
	  rate=$$(echo "$$info" | jq -r '.governance.toolRatePerMin // "?"'); \
	  oidc=$$(echo "$$info" | jq -r '.governance.oidcIssuer // ""'); \
	  oidcSfx=""; [ -n "$$oidc" ] && oidcSfx=" oidcIssuer=$$oidc"; \
	  echo "ok (authMode=$$authMode redaction=$$redaction auditPersisted=$$auditPersisted rate=$$rate/min$$oidcSfx)"; \
	fi
	@echo
	@echo "All good. Wire your agent up with:"
	@echo "  make connect-claude-code   # Claude Code / Claude Desktop"
	@echo "  make connect-cursor        # Cursor"

##@ Verification

# Unit tests run inside a throwaway node container so the host never needs npm.
test: ## Run mcp-server unit tests in Docker
	docker run --rm -w /app -v "$(PWD)/mcp-server:/app" node:20-alpine \
	  sh -c "npm install --silent --no-audit --no-fund && \
	         npx tsx --test src/analysis/*.test.ts src/config/*.test.ts src/sdk/*.test.ts src/auth/*.test.ts src/auth/oidc/*.test.ts src/auth/policy/*.test.ts src/tenancy/*.test.ts src/products/*.test.ts src/audit/*.test.ts src/catalog/*.test.ts src/policy/*.test.ts src/quota/*.test.ts src/tools/*.test.ts src/net/*.test.ts src/openapi.test.ts src/enterprise-gate.test.ts"

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

# Headless-browser UI smoke against the running demo stack. Runs the same
# Playwright suite that CI executes (`.github/workflows/ui-smoke.yml`).
# Assumes `make demo` (or `make smoke`) has the stack up. Docker-only —
# no host node/playwright install required.
ui-smoke: ## Build and run the Playwright UI smoke suite against the demo stack
	docker build -t omcp-ui-smoke:local mcp-server/playwright
	docker run --rm \
	  --network=host \
	  -e OMCP_UI_BASE=http://localhost:3000 \
	  omcp-ui-smoke:local

# MCP 2025-11-25 spec conformance harness. Boots the demo if not
# already up, points the harness at /mcp, runs node:test. CI
# (`.github/workflows/integration.yml`) runs the same target as a
# required check so a spec regression cannot land on main.
conformance: ## Run the MCP 2025-11-25 conformance test suite against the demo stack
	@for i in $$(seq 1 60); do \
	  curl -fsS http://localhost:3000/healthz >/dev/null 2>&1 && break; \
	  if [ $$i -eq 1 ]; then echo "Waiting for /healthz..."; fi; \
	  sleep 2; \
	done
	docker run --rm -w /app -v "$(PWD)/mcp-server:/app" \
	  --network=host \
	  -e OMCP_CONFORMANCE_URL=http://localhost:3000/mcp \
	  node:20-alpine sh -c \
	  "npx --yes tsx --test src/conformance/mcp-2025-11-25.test.ts"

# SCIM 2.0 (RFC 7643/7644) compliance harness. Requires the gateway to
# run with SCIM enabled (OMCP_SCIM_TOKEN set); point the suite at
# /scim/v2 with the matching bearer. Skips entirely if the URL is
# unset, so it's safe to call even when SCIM isn't configured.
scim-compliance: ## Run the SCIM 2.0 compliance suite against a SCIM-enabled gateway
	@for i in $$(seq 1 60); do \
	  curl -fsS http://localhost:3000/healthz >/dev/null 2>&1 && break; \
	  if [ $$i -eq 1 ]; then echo "Waiting for /healthz..."; fi; \
	  sleep 2; \
	done
	docker run --rm -w /app -v "$(PWD)/mcp-server:/app" \
	  --network=host \
	  -e OMCP_SCIM_COMPLIANCE_URL=$${OMCP_SCIM_COMPLIANCE_URL:-http://localhost:3000/scim/v2} \
	  -e OMCP_SCIM_COMPLIANCE_TOKEN=$${OMCP_SCIM_COMPLIANCE_TOKEN:-} \
	  node:20-alpine sh -c \
	  "npx --yes tsx --test src/scim/compliance.test.ts"

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

##@ Benchmark (Astronomy Shop hybrid)

# Where the upstream OTel Demo (Astronomy Shop) gets cloned to. Override
# with `make benchmark-up OTEL_DEMO_DIR=/path/to/your/clone` to reuse an
# existing checkout.
OTEL_DEMO_DIR ?= .benchmark/opentelemetry-demo
OTEL_DEMO_REPO ?= https://github.com/open-telemetry/opentelemetry-demo

benchmark-deps: ## Ensure the upstream OpenTelemetry Demo checkout exists
	@if [ ! -d "$(OTEL_DEMO_DIR)/.git" ]; then \
	  mkdir -p "$$(dirname $(OTEL_DEMO_DIR))"; \
	  echo "cloning $(OTEL_DEMO_REPO) → $(OTEL_DEMO_DIR) (shallow)"; \
	  git clone --depth 1 "$(OTEL_DEMO_REPO)" "$(OTEL_DEMO_DIR)"; \
	fi
	@echo "upstream demo ready at $(OTEL_DEMO_DIR)"

benchmark-up: benchmark-deps ## Start the hybrid benchmark stack: our Tempo+bridge + Astronomy Shop
	docker compose --profile benchmark up -d --wait
	# OTEL_COLLECTOR_HOST repoints upstream services from their own
	# collector to our bridge so traces land in our Tempo. The
	# upstream stack still brings up its own collector for its own
	# Jaeger UI — they coexist.
	@echo "starting upstream Astronomy Shop (this may pull ~4GB the first time)..."
	cd "$(OTEL_DEMO_DIR)" && \
	  OTEL_COLLECTOR_HOST=otel-collector-bridge \
	  docker compose -p otel-demo up -d
	# Join upstream's default network to ours so the bridge is
	# reachable from their services as `otel-collector-bridge:4317`.
	docker network connect observability_observability otel-demo_default 2>/dev/null || true
	@echo
	@echo "benchmark stack up."
	@echo "  Astronomy Shop frontend: http://localhost:8080"
	@echo "  Feature flag UI:         http://localhost:8080/feature"
	@echo "  observability-mcp:       http://localhost:3000"
	@echo "  Tempo:                   http://localhost:3200"
	@echo
	@echo "Re-point mcp-server sources at examples/benchmark/sources.yaml"
	@echo "via the Web UI (Sources tab) or by mounting the file as"
	@echo "/app/config/sources.yaml on next mcp-server restart."

benchmark-down: ## Stop the hybrid benchmark stack (both ours and upstream)
	-cd "$(OTEL_DEMO_DIR)" && docker compose -p otel-demo down
	# Stop only benchmark-profile services; do NOT pass -v here — it
	# would also wipe compose-wide volumes like k3s-kubeconfig and
	# mcp-plugins that belong to the demo profile.
	docker compose stop tempo otel-collector-bridge
	docker compose rm -f tempo otel-collector-bridge
	-docker volume rm observability-mcp_tempo-data 2>/dev/null || true

benchmark-run: ## Run the RCA harness baseline vs topology against the benchmark stack
	@command -v node >/dev/null || { echo "node required on the host for the harness"; exit 1; }
	@mkdir -p .benchmark/results
	node scripts/benchmark-rca.mjs \
	  --mode=baseline --chaos-driver=feature-flag --target=paymentservice \
	  --iterations=$(or $(ITERATIONS),5) \
	  > .benchmark/results/baseline.json
	node scripts/benchmark-rca.mjs \
	  --mode=topology --chaos-driver=feature-flag --target=paymentservice \
	  --iterations=$(or $(ITERATIONS),5) \
	  > .benchmark/results/topology.json
	@echo
	@echo "results:"
	@jq -r '"\(.mode): \(.totals)"' .benchmark/results/baseline.json .benchmark/results/topology.json
