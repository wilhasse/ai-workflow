# OCI conversation archive

CSLOG-166 provides a private conversation reader at `https://msg.supersaber.dev.br`. The Node service reads full messages from OCI MySQL at `10.0.0.36`. Reading copied conversations does not require local Doris, collectors, raw files, or the summary provider.

The browser supports login, host/source filters, indexed word search, conversation pagination, tool messages, summaries and Markdown handoff export. Session identity includes both `session_id` and `vm_id`. Browser sessions expire after 12 hours or a service restart. Logout revokes the current session immediately.

## Deploy the reader

Create a Cloudflare A record for `msg.supersaber.dev.br` pointing to `147.15.92.45`. Start with DNS-only while validating the origin certificate. Allow TCP 80 and 443 on the OCI VM and its network security group.

On the OCI VM, copy `deploy/.env.example` to `deploy/.env`. Set the existing MySQL and machine API credentials. Configure `HISTORY_USERNAME`, `HISTORY_PASSWORD_HASH`, and `HISTORY_ORIGIN=https://msg.supersaber.dev.br`. Keep the file mode at 600.

Generate a salted scrypt password hash through standard input:

```bash
read -r -s -p 'Password: ' history_password
printf '%s' "$history_password" | node scripts/create-login.js
unset history_password
```

Put the resulting hash in single quotes in `.env` so Compose preserves its dollar signs. Store the password privately. The plaintext password is not needed on the server. `API_TOKEN` must contain at least 24 characters and is separate from the browser login.

Build on the development host and transfer the image to avoid building on the small OCI VM:

```bash
docker build -t agent-history-oci:latest agent-history-oci-sync
docker save agent-history-oci:latest | ssh oci-ubuntu-pub docker load
```

Copy the module's deployment files to `~/agent-history-oci-sync/` on OCI without overwriting `deploy/.env`. Back up the existing code, environment file, and image tag before replacing the service.

```bash
cd ~/agent-history-oci-sync/deploy
docker compose up -d --no-build
curl --fail http://127.0.0.1:5002/health
```

Caddy obtains and renews the certificate, then redirects HTTP to HTTPS. Its certificate state is in persistent Docker volumes. After public HTTPS works, Cloudflare proxying can use Full (strict) TLS. Do not change unrelated applications' TLS settings. Verify that no cache rule overrides the application's `Cache-Control: no-store` responses.

The first upgrade adds `agent_sessions.last_activity`. Run `scripts/repair-activity.sql` once through a connection to the OCI `agent_history` database after schema migration. It fills activity from a finite aggregation of existing messages and creates metadata for message-only sessions. It can be rerun safely.

## Synchronize conversations

From the development host, run the normal replay first:

```bash
cd agent-history-oci-sync
scripts/delta-sync.sh --delta
```

Normal replay refreshes all source sessions, history, tasks, todos and sync-state rows. Messages replay the preceding 48 hours. Source event timestamps are treated as UTC. Doris text fields are decoded explicitly as UTF-8 because its legacy result-field collation otherwise corrupts emoji and other non-BMP characters in mysql2. Repeated uploads are idempotent; OCI-only retained messages are preserved.

A separate reconciliation sweeps all retained source messages to repair older late arrivals. Each invocation defaults to 100,000 rows and ten minutes. Progress resumes from acknowledged checkpoints in `~/.agent-history-oci-backfill.json`. A saved partial cycle does not mean reconciliation completed. A row arriving behind an active cursor is picked up by a following sweep.

```bash
scripts/delta-sync.sh --reconcile
```

For a finite complete sweep without per-invocation row/time limits, run the following in a persistent service or terminal. It can take over an hour and holds the shared sync lock; prefer scheduled bounded runs during normal operation.

```bash
SYNC_MAX_SECONDS=0 scripts/delta-sync.sh --reconcile --max-rows=0
```

Install the delta and reconciliation service/timer pairs from `deploy/systemd/` in `/etc/systemd/system/`, reload systemd, and enable both timers. Delta runs at :00 and :30. Reconciliation runs at :07 and :37 with a 15-minute service timeout, leaving time before the next delta. The shared lock prevents concurrent checkpoint/tunnel writers.

The wrapper opens its own SSH tunnel to OCI unless `OCI_API_URL` is provided. It reads the bearer from `~/oci/agent-history-oci-credentials.txt` unless `API_TOKEN` is already configured. Keep credentials out of shell arguments and logs.

Verify one stable conversation against all its source-retained message keys and text hashes:

```bash
scripts/delta-sync.sh --verify-session SESSION_ID VM_ID
```

The verifier allows older cloud-only rows and fails on missing or changed source rows. It does not claim to verify other sessions or non-text message fields. Aggregate source/cloud counts are observations only; larger cloud counts do not prove complete coverage.

`deploy/rsync-to-oci.sh` separately mirrors this host's Codex sessions/memories/history and Claude projects/history to `~/agent-history-raw/` on OCI every 15 minutes. This is an additive raw archive; it does not index files or prove coverage for other hosts. Direct collector dual-push is optional when its existing source host configuration permits it. Scheduled replay remains necessary to repair historical gaps and metadata.

## Generate summaries

Set `SUMMARY_BASE_URL`, `SUMMARY_API_KEY`, and an available `SUMMARY_MODEL` in OCI's environment. The deployed repair uses `claude-fable-5`; verify the configured provider's model list before changing it. Summary generation is optional for reading and handoff.

```bash
cd ~/agent-history-oci-sync/deploy
docker compose run -T --rm --no-deps -e SUMMARY_BATCH=1 -e SUMMARY_CONCURRENCY=1 api node src/summarize.js
```

Install and enable the hourly summarizer timer on OCI. Confirm a new `session_summaries.updated_at` value after a run. An active timer alone is not proof of successful summaries. If the configured provider is unavailable, full conversation reads still work.

## Verify changes

Run `npm test` in this module. HTTP tests cover login, expiry/logout, browser read-only permissions, bearer access, body limits and throttling. Sync tests cover old arrivals, changed metadata and interruption recovery.

The MySQL integration test runs only when `HISTORY_QUERY_TEST=1` and `MYSQL_DATABASE=cslog166_query_test`. Supply a disposable MySQL connection through `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, and `MYSQL_PASSWORD`. It deletes fixture rows in that explicitly named test database.

For acceptance, use trusted public HTTPS to sign in, search known text, open the exact host/session, paginate, export, and sign out. Verify anonymous reads fail, cookie-only ingest fails, and all browser requests stay on the public hostname. Repeat without client access to LAN services. Keep screenshots free of passwords and never store credentials in recordings or logs.

## API reference

Public endpoints are `/`, static assets, `/auth/login`, `/auth/session`, `/auth/logout`, and minimal `/health`. Auth writes require the exact configured HTTPS Origin and JSON. The browser cookie authorizes only allowlisted GET requests under `/api/agent-history/`.

Machine callers use `Authorization: Bearer <API_TOKEN>` on the existing unprefixed routes:

- `POST /ingest/{sessions,messages,history,tasks,todos,sync-state}`.
- `GET /sessions`, `/sessions/:id`, and `/sessions/:id/messages`.
- `GET /sessions/:id/handoff?vm_id=HOST&format=raw`.
- `GET /search?q=WORDS`, `/history`, `/tasks`, `/sync/status`, and `/stats`.

Send `vm_id` for conversation reads. Omitting it is accepted only for an unambiguous session. Pagination is capped at 500 messages or 100 other rows; handoff tail is capped at 200 messages. `dialog=1` selects user/assistant messages; `dialog=0` includes events and tools. Search uses MySQL FULLTEXT word semantics, not arbitrary substring matching.
