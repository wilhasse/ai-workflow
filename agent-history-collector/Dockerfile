FROM node:20-slim

WORKDIR /app
COPY package*.json ./
COPY src/ ./src/

USER node
CMD ["node", "src/collector.js"]
