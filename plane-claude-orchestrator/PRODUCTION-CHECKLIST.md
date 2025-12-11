# Production Deployment Checklist

Pre-deployment checklist for plane-claude-orchestrator before going to production.

## Prerequisites

### 1. System Requirements
- [ ] Docker 24.0+ installed
- [ ] Docker Compose V2 installed
- [ ] Minimum 2 GB RAM available for containers
- [ ] Minimum 10 GB disk space (for logs, volumes)
- [ ] Network access to Plane instance
- [ ] Valid SSL certificates (or Let's Encrypt setup)

### 2. Credentials and Configuration
- [ ] Plane API token created with sufficient permissions
- [ ] Plane workspace slug verified
- [ ] Project IDs collected (UUID format)
- [ ] Claude MCP configured at `/home/cslog/.claude.json`
- [ ] Plane MCP tested (`claude mcp call plane get_projects`)

## Security Hardening

### 3. SSL/TLS Configuration
- [ ] Replace self-signed certificates with Let's Encrypt or commercial certs
- [ ] Update nginx/nginx.conf with production certificate paths:
  ```nginx
  ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;
  ```
- [ ] Add certificate renewal cron job (for Let's Encrypt)
- [ ] Test HTTPS connections with SSL Labs (ssllabs.com/ssltest/)

### 4. CORS Restrictions
- [ ] Edit `plane-claude-orchestrator/src/api.py`
- [ ] Change `allow_origins=["*"]` to specific domain:
  ```python
  allow_origins=["https://yourdomain.com"]
  ```
- [ ] Restart plane-claude-orchestrator service

### 5. Access Control
- [ ] Restrict nginx access by IP if internal-only (optional)
- [ ] Set up firewall rules (ufw/iptables):
  ```bash
  sudo ufw allow 22/tcp   # SSH
  sudo ufw allow 80/tcp   # HTTP (redirect)
  sudo ufw allow 443/tcp  # HTTPS
  sudo ufw enable
  ```
- [ ] Disable unused services/ports
- [ ] Review Docker container capabilities

### 6. Secrets Management
- [ ] Ensure `.claude.json` has restrictive permissions (600)
  ```bash
  chmod 600 /home/cslog/.claude.json
  ```
- [ ] Do NOT commit sensitive config to git
- [ ] Consider using environment variables for sensitive config
- [ ] Review config.yaml for any hardcoded secrets

## Logging and Monitoring

### 7. Log Configuration
- [ ] Verify log rotation is enabled (daemon.py uses RotatingFileHandler)
- [ ] Set appropriate log level in config.yaml:
  ```yaml
  logging:
    level: INFO  # Use INFO in production, DEBUG for troubleshooting
    file: logs/orchestrator.log
  ```
- [ ] Configure system log rotation for Docker logs:
  ```bash
  sudo tee /etc/docker/daemon.json << EOF
  {
    "log-driver": "json-file",
    "log-opts": {
      "max-size": "10m",
      "max-file": "3"
    }
  }
  EOF
  sudo systemctl restart docker
  ```

### 8. Health Check Monitoring
- [ ] Set up external monitoring (UptimeRobot, Pingdom, etc.)
- [ ] Monitor endpoint: `https://yourdomain.com/health`
- [ ] Set up alerting for service failures
- [ ] Configure Docker health check timeouts if needed

### 9. Disk Space Monitoring
- [ ] Set up alerts for low disk space (< 20% free)
- [ ] Monitor Docker volume sizes:
  ```bash
  docker system df -v
  ```
- [ ] Schedule periodic cleanup of old Docker images:
  ```bash
  docker image prune -a --filter "until=168h"
  ```

## Data Persistence and Backups

### 10. Volume Backups
- [ ] Set up automated backups for Docker volumes:
  - `plane-orchestrator-data` (state files)
  - `plane-orchestrator-logs` (logs)
  - `tmux-session-data` (session metadata)
- [ ] Test backup restoration procedure
- [ ] Document backup schedule (e.g., daily at 3 AM)
- [ ] Store backups offsite or in cloud storage

**Example backup script:**
```bash
#!/bin/bash
# /home/cslog/scripts/backup-volumes.sh

BACKUP_DIR="/backup/docker-volumes"
DATE=$(date +%Y%m%d-%H%M%S)

mkdir -p "$BACKUP_DIR"

# Backup plane-orchestrator-data
docker run --rm \
  -v ai-workflow_plane-orchestrator-data:/data \
  -v "$BACKUP_DIR":/backup \
  alpine tar czf "/backup/plane-data-$DATE.tar.gz" -C /data .

# Backup logs
docker run --rm \
  -v ai-workflow_plane-orchestrator-logs:/data \
  -v "$BACKUP_DIR":/backup \
  alpine tar czf "/backup/plane-logs-$DATE.tar.gz" -C /data .

# Keep only last 7 days
find "$BACKUP_DIR" -name "*.tar.gz" -mtime +7 -delete
```

### 11. State File Management
- [ ] Verify state files are being persisted:
  ```bash
  docker exec ai-workflow-plane-orchestrator ls -la /app/data
  ```
- [ ] Test recovery from empty state (daemon should recover gracefully)
- [ ] Document state file format for manual recovery if needed

## Performance Optimization

### 12. Resource Limits
- [ ] Add resource limits to docker-compose.yml (optional but recommended):
  ```yaml
  plane-claude-orchestrator:
    deploy:
      resources:
        limits:
          cpus: '1.0'
          memory: 512M
        reservations:
          memory: 256M
  ```
- [ ] Monitor container resource usage:
  ```bash
  docker stats
  ```

### 13. Polling Configuration
- [ ] Verify polling intervals in config.yaml:
  ```yaml
  plane:
    poll_interval: 60  # 60 seconds for production (reduce load)
  ```
- [ ] Adjust completion detection polling if needed (currently 5 seconds)

## Operational Procedures

### 14. Deployment Process
- [ ] Document deployment procedure:
  1. Pull latest code from git
  2. Review changes (`git log`, `git diff`)
  3. Build images: `docker-compose build`
  4. Test locally if possible
  5. Deploy: `docker-compose up -d`
  6. Verify health: `docker-compose ps`
  7. Monitor logs: `docker-compose logs -f`
- [ ] Create rollback procedure (keep previous images tagged)

### 15. Service Restart Procedure
- [ ] Document restart commands:
  ```bash
  # Restart single service
  docker-compose restart plane-claude-orchestrator

  # Full stack restart
  docker-compose down && docker-compose up -d

  # Emergency stop (preserves volumes)
  docker-compose down
  ```

### 16. Log Access
- [ ] Document log access procedures:
  ```bash
  # View live logs
  docker-compose logs -f plane-claude-orchestrator

  # Export logs for analysis
  docker-compose logs --since 24h plane-claude-orchestrator > logs-$(date +%Y%m%d).txt

  # Access log files directly
  docker exec ai-workflow-plane-orchestrator cat /app/logs/orchestrator.log
  ```

## Testing and Validation

### 17. Pre-Deployment Testing
- [ ] Test with a non-production Plane project first
- [ ] Create test ticket and verify full workflow:
  1. Ticket appears in pending queue (dashboard)
  2. Approve → Claude Code session starts
  3. Complete → Ticket moves to completed queue
  4. Approve update → Comment posted to Plane
- [ ] Verify error handling:
  - Network interruption during Plane API call
  - Invalid ticket ID
  - Empty summary
- [ ] Load test: Create multiple tickets, approve in parallel

### 18. Post-Deployment Validation
- [ ] Verify all services healthy:
  ```bash
  docker-compose ps
  curl -k https://yourdomain.com/health
  ```
- [ ] Check logs for errors:
  ```bash
  docker-compose logs | grep -i error
  ```
- [ ] Test dashboard access from external network
- [ ] Verify Plane polling is working (check logs)
- [ ] Test completion detection with real ticket

## Documentation

### 19. Runbook Creation
- [ ] Document common issues and resolutions
- [ ] Create incident response procedures
- [ ] Document escalation contacts
- [ ] Maintain change log for configuration changes

### 20. User Training
- [ ] Train users on dashboard workflow
- [ ] Document `/complete` command usage
- [ ] Create video walkthrough (optional)
- [ ] Set up user feedback channel

## Compliance and Governance

### 21. Data Privacy
- [ ] Review data retention policies
- [ ] Ensure logs don't contain sensitive data (API tokens, passwords)
- [ ] Document data handling procedures
- [ ] Set up data deletion procedures (if required)

### 22. Audit Trail
- [ ] Enable audit logging for administrative actions
- [ ] Review access logs periodically
- [ ] Document who has access to production systems

## Final Pre-Launch Checklist

### 23. Go/No-Go Decision
- [ ] All critical items above completed
- [ ] Stakeholders informed of launch
- [ ] Backup/rollback plan ready
- [ ] Support team briefed
- [ ] Monitoring dashboards configured

### 24. Launch Day
- [ ] Deploy during low-traffic window
- [ ] Have all team members available for 1 hour post-launch
- [ ] Monitor logs actively for first 30 minutes
- [ ] Test end-to-end workflow with real ticket
- [ ] Communicate launch status to users

### 25. Post-Launch (First Week)
- [ ] Review logs daily
- [ ] Monitor error rates
- [ ] Collect user feedback
- [ ] Address any issues immediately
- [ ] Document lessons learned

## Maintenance Schedule

### Ongoing Tasks
- **Daily**: Check service health, review error logs
- **Weekly**: Review completed tickets, verify backups
- **Monthly**: Update dependencies, security patches, review metrics
- **Quarterly**: Capacity planning, performance review

## Emergency Contacts

- **Service Owner**: [Name, Email, Phone]
- **On-Call Engineer**: [Rotation schedule, escalation process]
- **Plane Admin**: [Contact for API issues]
- **Infrastructure Team**: [For Docker/network issues]

## Version Control

- **Document Version**: 1.0
- **Last Updated**: 2025-12-10
- **Reviewed By**: [Name]
- **Next Review Date**: [Date]

---

**Sign-off**:

- [ ] Technical Lead: ___________________ Date: ___________
- [ ] Operations Lead: ___________________ Date: ___________
- [ ] Security Review: ___________________ Date: ___________
