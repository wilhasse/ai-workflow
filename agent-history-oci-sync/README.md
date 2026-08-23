# agent-history-oci-sync

OCI MySQL index for agent conversation history (CSLOG-166). Mirrors the
`agent_history` Doris dataset into the OCI Always Free MySQL
(`mysql-free-agents`, 10.0.0.36, VCN-private) so history stays queryable when
the local infra (godev4 / Doris 10.1.0.7) is off.

Components:

- **Ingest/query API** (`src/server.js`) — same `/ingest/:entity` contract as
  `agent-history-service`, backed by compressed InnoDB tables
  (`ROW_FORMAT=COMPRESSED KEY_BLOCK_SIZE=8`) with FULLTEXT indexes. Bearer auth
  on everything except `/health`.
- **Summarizer** (`src/summarize.js`) — batch job that generates LLM summaries
  into `session_summaries` via an OpenAI-compatible endpoint (default:
  CLIProxyAPI public URL). Summaries are the permanent compact reference layer.
- **Handoff export** — `GET /sessions/:id/handoff?format=raw` returns
  paste-ready markdown (summary + recent dialog) to continue a conversation in
  a local agent without this infra.
- **Backfill** (`scripts/backfill.js`) — one-time, resumable Doris -> OCI copy
  over the ingest API (idempotent upserts), with per-table count verification.
- **Raw archive** (`deploy/rsync-to-oci.sh`) — plain-file rsync mirror of
  `~/.codex/{sessions,memories,history.jsonl}` and `~/.claude/{projects,history.jsonl}`
  to `oci-ubuntu-pub:~/agent-history-raw/`.

## Deploy on oci-ubuntu-pub

```bash
rsync -a --delete --exclude node_modules --exclude deploy/.env \
  agent-history-oci-sync/ oci-ubuntu-pub:agent-history-oci-sync/
ssh oci-ubuntu-pub
cd agent-history-oci-sync/deploy
cp .env.example .env   # fill API_TOKEN, MYSQL_PASSWORD, SUMMARY_API_KEY, DOMAIN
chmod 600 .env
docker compose up -d --build
curl http://127.0.0.1:5002/health
```

`DOMAIN` needs an A record pointing at 147.15.92.45 before Caddy can issue the
Let's Encrypt cert. Until then the API is reachable on the VM loopback only
(use `ssh -L 5002:127.0.0.1:5002 oci-ubuntu-pub` from godev4).

Summarizer (on the VM):

```bash
# one-time bulk pass over all codex sessions (hours), then the hourly timer
docker compose run -T --rm --no-deps \
  -e SUMMARY_LOOPS=0 -e SUMMARY_CONCURRENCY=4 api node src/summarize.js
sudo cp systemd/agent-history-oci-summarizer.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agent-history-oci-summarizer.timer
```

Useful summarizer env vars: `SUMMARY_SOURCE` (default `codex`; empty = all),
`SUMMARY_MODEL`, `SUMMARY_TEMPERATURE` (omit for CPA reasoning models).

## godev4 side

Collector dual-push (container `agent-history-collector`): add to
`docker-compose-agent-history-collector.yml` environment:

```yaml
OCI_API_URL=https://agent-history.cslog.com.br
OCI_API_TOKEN=<same as API_TOKEN on the VM>
```

then `docker compose -f docker-compose-agent-history-collector.yml up -d --build`.

Raw-archive timer (on godev4):

```bash
chmod +x deploy/rsync-to-oci.sh
sudo cp deploy/systemd/agent-history-oci-rsync.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agent-history-oci-rsync.timer
```

Backfill (from godev4, via SSH tunnel until DNS/TLS is live):

```bash
ssh -L 5002:127.0.0.1:5002 oci-ubuntu-pub   # keep open
cd agent-history-oci-sync && npm install
OCI_API_URL=http://127.0.0.1:5002 API_TOKEN=... npm run backfill
```

Ongoing delta sync (godev4, every 30 min, opens its own tunnel):

```bash
sudo cp deploy/systemd/agent-history-oci-delta.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agent-history-oci-delta.timer
```

Note: `agent_tasks`/`agent_todos`/`sync_state` are mutable and re-read in full
every run; messages/sessions/history use append-only watermark resume. OCI is
the retention superset — Doris pruning is not mirrored.

## API

All endpoints except `/health` require `Authorization: Bearer <API_TOKEN>`.

- `POST /ingest/{sessions,messages,history,tasks,todos,sync-state}`
- `GET /sessions?source=&vm_id=&project=&from=&to=&limit=&offset=`
- `GET /sessions/:id` / `GET /sessions/:id/messages`
- `GET /sessions/:id/handoff?tail=40&format=raw`
- `GET /search?q=&source=&vm_id=&project=&from=&to=`
- `GET /history` / `GET /tasks` / `GET /sync/status` / `GET /stats`
