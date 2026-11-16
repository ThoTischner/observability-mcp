FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5
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
