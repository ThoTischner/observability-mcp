FROM node:26-alpine@sha256:e71ac5e964b9201072425d59d2e876359efa25dc96bb1768cb73295728d6e4ea
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
