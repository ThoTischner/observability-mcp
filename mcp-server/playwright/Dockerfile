# Pinned Playwright image already contains Chromium + system deps.
# Stays bit-for-bit reproducible across local + CI runs.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /work

# Install just the test runner — Chromium is already in the base image.
COPY package.json package.json
RUN npm install --no-audit --no-fund --silent

COPY playwright.config.mjs ./playwright.config.mjs
COPY smoke.spec.mjs        ./smoke.spec.mjs
COPY tables-filters-density.spec.mjs ./tables-filters-density.spec.mjs

# When run with --network=host (Linux) OMCP_UI_BASE defaults to localhost.
# In a compose network pass OMCP_UI_BASE=http://mcp-server:3000 explicitly.
ENV CI=1
CMD ["npx", "playwright", "test", "--config=playwright.config.mjs"]
