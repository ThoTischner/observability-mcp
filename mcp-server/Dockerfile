# --- Build stage -----------------------------------------------------------
# Installs deps + compiles TS. Everything here is throwaway; only the
# artefacts under /app are copied into the runtime stage.
FROM node:26-alpine@sha256:e71ac5e964b9201072425d59d2e876359efa25dc96bb1768cb73295728d6e4ea AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
# npm ci honors the lockfile + overrides — the only way to get a
# reproducible build matching what CI's npm-audit signs off on.
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build
# Drop devDependencies so the runtime image only carries what `node`
# actually loads at runtime.
RUN npm prune --omit=dev

# --- Runtime stage ---------------------------------------------------------
# Same base, but we delete npm itself. npm's bundled node_modules carry
# transitive deps (e.g. ip-address) that surface as CVEs even though the
# server never invokes npm at runtime. Removing it shrinks the image and
# silences false-positive scans like the one ArtifactHub reported.
FROM node:26-alpine@sha256:e71ac5e964b9201072425d59d2e876359efa25dc96bb1768cb73295728d6e4ea

ARG GIT_COMMIT=""
ARG BUILD_DATE=""

LABEL org.opencontainers.image.title="observability-mcp" \
      org.opencontainers.image.description="Unified observability gateway for AI agents." \
      org.opencontainers.image.source="https://github.com/ThoTischner/observability-mcp" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${GIT_COMMIT}" \
      org.opencontainers.image.created="${BUILD_DATE}"

ENV GIT_COMMIT=$GIT_COMMIT BUILD_DATE=$BUILD_DATE NODE_ENV=production

# Strip the package managers we don't need at runtime. yarn ships
# pre-installed on node:alpine too; nuke it as well.
RUN rm -rf \
      /usr/local/lib/node_modules/npm \
      /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg \
      /usr/local/bin/corepack \
      /opt/yarn-* 2>/dev/null || true

WORKDIR /app
COPY --from=builder --chown=node:node /app/dist          ./dist
COPY --from=builder --chown=node:node /app/node_modules  ./node_modules
COPY --from=builder --chown=node:node /app/package.json  ./package.json
COPY --from=builder --chown=node:node /app/plugins       ./plugins
COPY --from=builder --chown=node:node /app/config        ./config

USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
