FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5
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
