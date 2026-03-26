FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npx tsc && cp -r src/ui dist/ui
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
