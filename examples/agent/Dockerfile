FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94
WORKDIR /app
COPY package.json package-lock.json ./
# `npm ci` over `npm install` so the install is locked to the
# committed package-lock.json (OpenSSF Scorecard pinning).
RUN npm ci --no-audit --no-fund
COPY . .
RUN npx tsc
RUN chown -R node:node /app
USER node
CMD ["node", "dist/index.js"]
