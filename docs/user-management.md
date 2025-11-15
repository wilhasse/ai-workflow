# User Accounts and Persistence

This project keeps per-user terminal/project settings inside the `tmux-session-service`. The service manages credentials, issues bearer tokens, and stores every user’s project definitions so they survive container restarts.

## Where data lives

- Runtime path: `tmux-session-service/data/users.json`
- Docker volume: `tmux-session-data` (declared in `docker-compose.yml`).
- Each record includes the username, a `scrypt`-hashed password, and the serialized list of projects + terminals for that user. Tokens are in-memory and are cleared when the service restarts.

## Creating a user (UI)

1. Bring up the stack: `docker-compose up -d --build`.
2. Visit the dashboard (https://localhost by default).
3. In the top auth bar, switch to “Register”, enter a username + password (min 6 chars), and submit.
4. The UI stores the token in `localStorage` (`terminal-dashboard-auth-token`) and immediately syncs any project changes back to the service.

## Creating a user (API)

Use nginx as the entry point—do **not** hit port 5001 directly from the host:

```bash
curl -k -X POST https://localhost/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"demo","password":"secret123"}'
```

Response contains a `token` and the initial project payload. Store the token and send it as `Authorization: Bearer <token>` for future calls (`/api/auth/login`, `/api/me`, `/api/me/projects`).

## Verifying tmux-session-service

```bash
docker exec -it ai-workflow-tmux-service curl http://localhost:5001/health
```

This confirms tmux is available and the API is healthy. Use `/api/me/projects` to confirm project persistence:

```bash
curl -k https://localhost/api/me/projects -H "Authorization: Bearer $TOKEN"
```

The returned JSON mirrors the `users.json` data and is what the dashboard loads on login.
