FROM node:25-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
