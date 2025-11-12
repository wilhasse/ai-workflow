# AI Workflow - Production Deployment Guide

Complete guide for deploying AI Workflow using Docker Compose in production.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Deployment Steps](#deployment-steps)
- [SSL Certificates](#ssl-certificates)
- [Monitoring](#monitoring)
- [Troubleshooting](#troubleshooting)
- [Backup and Restore](#backup-and-restore)
- [Updating](#updating)

## Prerequisites

### Required Software

- **Docker** 20.10+ ([Installation Guide](https://docs.docker.com/engine/install/))
- **Docker Compose** 2.0+ ([Installation Guide](https://docs.docker.com/compose/install/))
- **Git** for cloning the repository

### System Requirements

- **CPU**: 2+ cores recommended
- **RAM**: 4GB minimum, 8GB recommended
- **Disk**: 10GB available space
- **OS**: Linux (Ubuntu 20.04+, Debian 11+, CentOS 8+)

### Network Requirements

- **Ports**: 80 (HTTP), 443 (HTTPS) must be available
- **Firewall**: Allow incoming connections on ports 80 and 443
- **Domain** (optional): For production with Let's Encrypt SSL

## Quick Start

```bash
# Clone the repository
git clone https://github.com/wilhasse/ai-workflow.git
cd ai-workflow

# Build and start all services
docker-compose up -d

# Check service status
docker-compose ps

# View logs
docker-compose logs -f

# Access the application
# Open browser to: https://localhost (or https://your-server-ip)
```

That's it! The application is now running with all services orchestrated.

## Architecture

### Services

The deployment consists of 3 main services:

```
┌─────────────────────────────────────────────────────┐
│                    Internet                          │
└──────────────────────┬──────────────────────────────┘
                       │ :80, :443
            ┌──────────▼──────────┐
            │   nginx (Reverse    │
            │   Proxy + SSL)      │
            └──┬──────┬─────┬─────┘
               │      │     │
       ┌───────┘      │     └────────┐
       │              │              │
┌────────────┐ ┌──────────────────────────────┐
│ terminal-  │ │ tmux-session-service (API + │
│ dashboard  │ │ WebSocket bridge)           │
│ (React)    │ │                              │
└────────────┘ └──────────────────────────────┘
```

1. **nginx** - Reverse proxy, SSL termination, routing
2. **terminal-dashboard** - React frontend with embedded xterm.js terminals
3. **tmux-session-service** - API + WebSocket bridge for persistent tmux sessions

### Network

All services communicate through a Docker bridge network (`ai-workflow-network`), isolated from the host except for exposed ports 80/443.

### Volumes

- `tmux-session-data` - Persistent storage for session metadata

## Configuration

### Environment Variables

Edit `.env.production` to customize your deployment:

```bash
# Ports
HTTP_PORT=80
HTTPS_PORT=443
TMUX_SERVICE_PORT=5001

# SSL Configuration
SSL_TYPE=selfsigned          # Use "letsencrypt" for production
# LETSENCRYPT_EMAIL=admin@example.com

# Domain (optional, for Let's Encrypt)
# DOMAIN=workflow.example.com
```

### nginx Configuration

Edit `nginx/nginx.conf` to customize:

- Server names
- SSL settings
- Proxy timeouts
- Security headers
- Custom routes

### Terminal Bridge Configuration

The terminal dashboard connects to `tmux-session-service` through nginx:

- `/api/sessions/` proxies HTTP lifecycle requests
- `/ws/sessions/` upgrades to a WebSocket that streams tmux I/O

Adjust timeouts, TLS ciphers, or access controls for these routes inside `nginx/nginx.conf`.

## Deployment Steps

### 1. Clone Repository

```bash
git clone https://github.com/wilhasse/ai-workflow.git
cd ai-workflow
```

### 2. Review Configuration

```bash
# Edit environment variables
nano .env.production

# Review docker-compose configuration
nano docker-compose.yml
```

### 3. Build Images

```bash
# Build all Docker images (first time only)
docker-compose build

# Or build specific service
docker-compose build terminal-dashboard
```

### 4. Start Services

```bash
# Start all services in detached mode
docker-compose up -d

# Start with logs visible
docker-compose up

# Start specific services
docker-compose up -d nginx terminal-dashboard
```

### 5. Verify Deployment

```bash
# Check running containers
docker-compose ps

# Should show all services as "Up" and "healthy"

# Check logs for errors
docker-compose logs

# Follow logs in real-time
docker-compose logs -f

# Check specific service
docker-compose logs tmux-session-service
```

### 6. Access Application

Open your browser to:
- `https://localhost` (if running locally)
- `https://your-server-ip` (if running on remote server)
- `https://your-domain.com` (if you configured a domain)

**Note**: Self-signed certificates will show a security warning. This is expected for development. For production, configure Let's Encrypt (see SSL Certificates section).

## SSL Certificates

### Development: Self-Signed Certificates

The default configuration uses self-signed SSL certificates, which are automatically generated during build.

**Browser Warning**: You'll see a security warning. Click "Advanced" → "Proceed to site" to continue.

### Production: Let's Encrypt

For production with a real domain:

1. **Update Configuration**:
   ```bash
   # Edit .env.production
   SSL_TYPE=letsencrypt
   DOMAIN=your-domain.com
   LETSENCRYPT_EMAIL=admin@your-domain.com
   ```

2. **Update nginx Configuration**:
   Edit `nginx/nginx.conf` and update `server_name`:
   ```nginx
   server_name your-domain.com www.your-domain.com;
   ```

3. **Install Certbot** (on host):
   ```bash
   sudo apt-get install certbot python3-certbot-nginx
   ```

4. **Obtain Certificate**:
   ```bash
   # Stop nginx container
   docker-compose stop nginx

   # Obtain certificate
   sudo certbot certonly --standalone \
     -d your-domain.com \
     -d www.your-domain.com \
     --email admin@your-domain.com \
     --agree-tos

   # Certificates will be in /etc/letsencrypt/live/your-domain.com/
   ```

5. **Mount Certificates in docker-compose.yml**:
   ```yaml
   nginx:
     volumes:
       - /etc/letsencrypt:/etc/letsencrypt:ro
   ```

6. **Update nginx SSL paths**:
   ```nginx
   ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
   ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;
   ```

7. **Restart nginx**:
   ```bash
   docker-compose up -d nginx
   ```

### Certificate Renewal

Let's Encrypt certificates expire after 90 days. Set up automatic renewal:

```bash
# Add cron job
sudo crontab -e

# Add this line (runs daily at 2:30 AM)
30 2 * * * certbot renew --quiet --post-hook "docker-compose -f /path/to/ai-workflow/docker-compose.yml restart nginx"
```

## Monitoring

### Service Health

```bash
# Check health status of all services
docker-compose ps

# View detailed health check logs
docker inspect ai-workflow-nginx | grep -A 20 Health
```

### Logs

```bash
# View all logs
docker-compose logs

# Follow logs in real-time
docker-compose logs -f

# View logs for specific service
docker-compose logs -f tmux-session-service

# View last 100 lines
docker-compose logs --tail=100

# View logs with timestamps
docker-compose logs -t
```

### Resource Usage

```bash
# View resource usage
docker stats

# View disk usage
docker system df

# Detailed volume usage
docker volume ls
docker volume inspect ai-workflow_tmux-session-data
```

### Health Checks

All services have built-in health checks:

- **nginx**: HTTP request to `/health` endpoint
- **terminal-dashboard**: HTTP request to root
- **tmux-session-service**: HTTP request to `/health` endpoint

Health checks run every 30 seconds and retry 3 times before marking unhealthy.

## Troubleshooting

### Services Won't Start

```bash
# Check logs for errors
docker-compose logs

# Verify port availability
sudo netstat -tulpn | grep -E ':(80|443|5001)'

# Restart services
docker-compose restart

# Rebuild if needed
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

### Terminal Not Loading

1. **Check tmux-session-service logs**:
   ```bash
   docker-compose logs -f tmux-session-service
   ```

2. **Verify the API is healthy**:
   ```bash
   docker-compose ps tmux-session-service
   curl http://tmux-session-service:5001/health
   ```

3. **Test the WebSocket bridge** (from the nginx container or host with network access):
   ```bash
   npx wscat -c ws://localhost:5001/ws/sessions/debug-shell
   ```

4. **Confirm nginx is proxying `/ws/sessions/`**:
   - Check `nginx/nginx.conf` for the WebSocket location block
   - Reload nginx if changes were made: `docker-compose exec nginx nginx -s reload`

### SSL Certificate Errors

1. **Accept self-signed certificate** (development):
   - Chrome/Edge: Click "Advanced" → "Proceed"
   - Firefox: Click "Advanced" → "Accept Risk"

2. **Check certificate validity** (production):
   ```bash
   openssl x509 -in /etc/letsencrypt/live/your-domain.com/cert.pem -text -noout
   ```

### Performance Issues

1. **Check resource usage**:
   ```bash
   docker stats
   ```

2. **Increase resources** in docker-compose.yml:
   ```yaml
   services:
     terminal-dashboard:
       deploy:
         resources:
           limits:
             cpus: '2'
             memory: 2G
   ```

3. **Check disk space**:
   ```bash
   df -h
   docker system df
   ```

### Connection Reset

If terminals disconnect frequently:

1. **Increase proxy timeouts** in `nginx/nginx.conf`:
   ```nginx
   proxy_read_timeout 7200s;
   proxy_send_timeout 7200s;
   ```

2. **Restart nginx**:
   ```bash
   docker-compose restart nginx
   ```

## Backup and Restore

### Backup Session Data

```bash
# Backup session data volume
docker run --rm \
  -v ai-workflow_tmux-session-data:/data \
  -v $(pwd):/backup \
  alpine tar czf /backup/sessions-backup-$(date +%Y%m%d).tar.gz -C /data .

# Verify backup
ls -lh sessions-backup-*.tar.gz
```

### Restore Session Data

```bash
# Stop services
docker-compose down

# Restore from backup
docker run --rm \
  -v ai-workflow_tmux-session-data:/data \
  -v $(pwd):/backup \
  alpine sh -c "cd /data && tar xzf /backup/sessions-backup-20250110.tar.gz"

# Restart services
docker-compose up -d
```

### Backup Entire Configuration

```bash
# Backup all configuration and data
tar czf ai-workflow-full-backup-$(date +%Y%m%d).tar.gz \
  docker-compose.yml \
  .env.production \
  nginx/ \
  terminal-dashboard/ \
  tmux-session-service/

# Include Docker volumes
docker run --rm \
  -v ai-workflow_tmux-session-data:/data \
  -v $(pwd):/backup \
  alpine tar czf /backup/volumes-backup-$(date +%Y%m%d).tar.gz -C /data .
```

## Updating

### Update Application Code

```bash
# Pull latest code
git pull origin main

# Rebuild images
docker-compose build

# Restart with new images
docker-compose up -d

# Verify update
docker-compose logs -f
```

### Update Individual Service

```bash
# Rebuild specific service
docker-compose build terminal-dashboard

# Restart only that service
docker-compose up -d terminal-dashboard

# Verify
docker-compose ps terminal-dashboard
```

### Update Docker Images

```bash
# Pull latest base images
docker-compose pull

# Rebuild
docker-compose build --pull

# Restart
docker-compose up -d
```

### Rollback

```bash
# Stop current deployment
docker-compose down

# Checkout previous version
git checkout <previous-commit>

# Rebuild and start
docker-compose build
docker-compose up -d
```

## Production Checklist

Before deploying to production:

- [ ] Update domain in `.env.production` and `nginx/nginx.conf`
- [ ] Configure Let's Encrypt SSL certificates
- [ ] Set up firewall rules (allow 80/443, block 5001)
- [ ] Configure automated backups (cron job)
- [ ] Set up certificate auto-renewal
- [ ] Configure monitoring/alerting
- [ ] Review and harden nginx security settings
- [ ] Change default ports if needed
- [ ] Test disaster recovery procedure
- [ ] Document custom configuration
- [ ] Set up log rotation
- [ ] Configure resource limits

## Security Considerations

### Firewall Configuration

```bash
# Allow HTTP and HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Block direct access to backend services
sudo ufw deny 5001/tcp
sudo ufw deny 4200/tcp

# Enable firewall
sudo ufw enable
```

### Security Headers

nginx is configured with security headers:
- `X-Frame-Options: SAMEORIGIN`
- `X-Content-Type-Options: nosniff`
- `X-XSS-Protection: 1; mode=block`
- `Strict-Transport-Security` (HTTPS only)

### Authentication

The default deployment has no authentication. For production:

1. Add nginx basic authentication
2. Implement OAuth2 proxy
3. Use VPN for access control
4. Add IP whitelisting in nginx

## Support

### Documentation

- [Main README](README.md)
- [Architecture Guide](tmux-session-service/ARCHITECTURE.md)
- [Installation Guide](tmux-session-service/INSTALL.md)

### Issues

Report issues at: https://github.com/wilhasse/ai-workflow/issues

### Logs

When reporting issues, include:
```bash
docker-compose logs > logs.txt
docker-compose ps > services.txt
docker version > docker-info.txt
```

---

**Last Updated**: January 2025
**Version**: 1.0.0
