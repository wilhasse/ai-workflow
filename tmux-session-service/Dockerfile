FROM node:20-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends tmux curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 5001
CMD ["node", "src/server.js"]
