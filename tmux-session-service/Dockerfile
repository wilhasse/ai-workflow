FROM node:20-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends tmux curl ca-certificates openssh-client python3 make g++ sudo locales \
  && echo "pt_BR.UTF-8 UTF-8" >> /etc/locale.gen \
  && echo "en_US.UTF-8 UTF-8" >> /etc/locale.gen \
  && locale-gen \
  && rm -rf /var/lib/apt/lists/*

ENV PULUMI_VERSION=3.167.0

RUN curl -fsSL https://get.pulumi.com -o /tmp/install-pulumi.sh \
  && sh /tmp/install-pulumi.sh --version "${PULUMI_VERSION}" \
  && rm /tmp/install-pulumi.sh \
  && ln -s /root/.pulumi/bin/pulumi /usr/local/bin/pulumi

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

# Create data directory and set permissions
RUN mkdir -p /app/data && chown -R cslog:cslog /app

# Set up entrypoint script (already copied via COPY . .)
RUN cp /app/docker-entrypoint.sh /usr/local/bin/ \
  && chmod +x /usr/local/bin/docker-entrypoint.sh

# Switch to cslog user
USER cslog

EXPOSE 5001
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
