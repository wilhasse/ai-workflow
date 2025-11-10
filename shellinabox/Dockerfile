FROM debian:bullseye-slim

# Install shellinabox, tmux, curl, and openssl
RUN apt-get update && \
    apt-get install -y \
    shellinabox \
    tmux \
    curl \
    openssl \
    && rm -rf /var/lib/apt/lists/*

# Create directory for attach script
RUN mkdir -p /usr/local/bin/tmux-session-service

# Copy attach-session.sh script
COPY attach-session.sh /usr/local/bin/tmux-session-service/attach-session.sh
RUN chmod +x /usr/local/bin/tmux-session-service/attach-session.sh

# Create directory for SSL certificates
RUN mkdir -p /var/lib/shellinabox

# Generate self-signed SSL certificate
RUN openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout /var/lib/shellinabox/certificate.pem \
    -out /var/lib/shellinabox/certificate.pem \
    -subj "/C=US/ST=State/L=City/O=Organization/CN=localhost"

# Set environment variables
ENV SESSION_SERVICE_URL=http://tmux-session-service:5001

# Expose shellinabox port
EXPOSE 4200

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -k -f https://localhost:4200/ || exit 1

# Start shellinabox
CMD ["/usr/bin/shellinaboxd", \
     "--port=4200", \
     "--no-beep", \
     "--disable-ssl-menu", \
     "--cert=/var/lib/shellinabox", \
     "--service=/:LOGIN:LOGIN:HOME:/usr/local/bin/tmux-session-service/attach-session.sh"]
