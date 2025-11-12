FROM node:20-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends tmux curl python3 make g++ sudo \
  && rm -rf /var/lib/apt/lists/*

# Rename the 'node' user to 'cslog' (node user is UID 1000 by default)
# This ensures tmux sessions run as 'cslog' user
RUN usermod -l cslog node \
  && groupmod -n cslog node \
  && usermod -d /home/cslog -m cslog \
  && echo "cslog ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

# Change ownership to cslog user
RUN chown -R cslog:cslog /app

# Switch to cslog user
USER cslog

EXPOSE 5001
CMD ["node", "src/server.js"]
