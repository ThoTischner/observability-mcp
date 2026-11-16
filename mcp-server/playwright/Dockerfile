# Pinned Playwright image already contains Chromium + system deps.
# Stays bit-for-bit reproducible across local + CI runs.
# Digest-pinned for OpenSSF Scorecard PinnedDependenciesID.
FROM mcr.microsoft.com/playwright:v1.65.1-jammy@sha256:b0ee5ce5e14ac42c394c0564a0a30adbda052153c611561bb2d31263593d6dd8

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
COPY inspect.spec.mjs ./inspect.spec.mjs
COPY governance.spec.mjs ./governance.spec.mjs
COPY entitlement-locks.spec.mjs ./entitlement-locks.spec.mjs

# Run as the image's unprivileged user (Chromium sandboxing expects it too).
RUN chown -R pwuser:pwuser /work
USER pwuser

# When run with --network=host (Linux) OMCP_UI_BASE defaults to localhost.
# In a compose network pass OMCP_UI_BASE=http://mcp-server:3000 explicitly.
ENV CI=1
CMD ["npx", "playwright", "test", "--config=playwright.config.mjs"]
