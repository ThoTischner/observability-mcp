FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94
WORKDIR /app
COPY package.json ./
# Demo services intentionally use a lockfile-less install so they
# pick up patch releases of their tiny dep set (only `tsx` runtime).
# OpenSSF Scorecard PinnedDependenciesID is accepted here because:
# (a) the base image is digest-pinned, (b) the services are demo-
# only and never reach production, (c) committing a lockfile would
# add noise without security gain for a single-dep tree.
RUN npm install --no-audit --no-fund
COPY . .
# Run unprivileged, and call tsx directly: npx would want a writable npm
# cache in $HOME, which a read-only root filesystem doesn't have.
USER node
CMD ["sh", "-c", "exec node_modules/.bin/tsx src/${SERVICE_NAME}.ts"]
