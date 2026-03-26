FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npx tsc
RUN chown -R node:node /app
USER node
CMD ["node", "dist/index.js"]
