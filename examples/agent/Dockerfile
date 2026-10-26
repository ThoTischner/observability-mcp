FROM node:26-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797
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
