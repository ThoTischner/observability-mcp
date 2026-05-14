FROM node:26-alpine

# Build-time metadata. Both default empty so a bare `docker build` works.
# CI passes --build-arg GIT_COMMIT=$(git rev-parse HEAD) and BUILD_DATE
# so /api/info reports them.
ARG GIT_COMMIT=""
ARG BUILD_DATE=""

# OCI image labels — picked up by registries and SBOM tooling.
LABEL org.opencontainers.image.title="observability-mcp" \
      org.opencontainers.image.description="Unified observability gateway for AI agents." \
      org.opencontainers.image.source="https://github.com/ThoTischner/observability-mcp" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${GIT_COMMIT}" \
      org.opencontainers.image.created="${BUILD_DATE}"

ENV GIT_COMMIT=$GIT_COMMIT BUILD_DATE=$BUILD_DATE

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
