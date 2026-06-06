FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
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
CMD ["sh", "-c", "npx tsx src/${SERVICE_NAME}.ts"]
