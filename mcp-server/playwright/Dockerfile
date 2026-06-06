# Pinned Playwright image already contains Chromium + system deps.
# Stays bit-for-bit reproducible across local + CI runs.
# Digest-pinned for OpenSSF Scorecard PinnedDependenciesID.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy@sha256:019b822658965bf5f6d509472802797554360f2940e677b2afb0f17748d0d0e3

WORKDIR /work

# Install just the test runner — Chromium is already in the base image.
# Scorecard PinnedDependenciesID flags `npm install`; the directory
# doesn't ship a lockfile (the smoke tests deliberately use latest
# patch releases of @playwright/test). The Playwright base image is
# digest-pinned above; the test surface is read-only.
COPY package.json package.json
RUN npm install --no-audit --no-fund --silent

COPY playwright.config.mjs ./playwright.config.mjs
COPY smoke.spec.mjs        ./smoke.spec.mjs
COPY tables-filters-density.spec.mjs ./tables-filters-density.spec.mjs
COPY topology.spec.mjs ./topology.spec.mjs
COPY rail.spec.mjs ./rail.spec.mjs

# When run with --network=host (Linux) OMCP_UI_BASE defaults to localhost.
# In a compose network pass OMCP_UI_BASE=http://mcp-server:3000 explicitly.
ENV CI=1
CMD ["npx", "playwright", "test", "--config=playwright.config.mjs"]
