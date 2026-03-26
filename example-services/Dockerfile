FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
CMD ["sh", "-c", "npx tsx src/${SERVICE_NAME}.ts"]
