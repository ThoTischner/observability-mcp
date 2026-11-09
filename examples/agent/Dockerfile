FROM node:26-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216
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
