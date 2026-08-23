import { getPool } from './connection.js'

// All content tables use ROW_FORMAT=COMPRESSED (InnoDB, KEY_BLOCK_SIZE=8)
// to keep the 50 GB Always Free storage comfortable.
// FULLTEXT on compressed InnoDB must be validated live on OCI MySQL 26.7
// the first time this schema is applied.

const COMPRESSED = 'ENGINE=InnoDB ROW_FORMAT=COMPRESSED KEY_BLOCK_SIZE=8 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
const PLAIN = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'

const DDL = [
  `CREATE TABLE IF NOT EXISTS agent_sessions (
    session_id      VARCHAR(64)  NOT NULL,
    vm_id           VARCHAR(64)  NOT NULL,
    started_at      DATETIME     NOT NULL,
    source          VARCHAR(16)  NOT NULL DEFAULT '',
    project         VARCHAR(512) DEFAULT NULL,
    display_text    MEDIUMTEXT   DEFAULT NULL,
    session_meta    MEDIUMTEXT   DEFAULT NULL,
    message_count   INT          NOT NULL DEFAULT 0,
    last_synced_at  DATETIME     NOT NULL,
    PRIMARY KEY (session_id, vm_id, started_at),
    KEY idx_started_at (started_at),
    KEY idx_source (source),
    FULLTEXT KEY ft_display_text (display_text)
  ) ${COMPRESSED}`,

  `CREATE TABLE IF NOT EXISTS agent_messages (
    message_id      VARCHAR(64)  NOT NULL,
    session_id      VARCHAR(64)  NOT NULL,
    vm_id           VARCHAR(64)  NOT NULL,
    ts              DATETIME     NOT NULL,
    source          VARCHAR(16)  NOT NULL DEFAULT '',
    msg_type        VARCHAR(32)  NOT NULL DEFAULT '',
    msg_role        VARCHAR(16)  NOT NULL DEFAULT '',
    content_text    MEDIUMTEXT   DEFAULT NULL,
    content_json    MEDIUMTEXT   DEFAULT NULL,
    parent_uuid     VARCHAR(64)  DEFAULT NULL,
    seq_num         INT          NOT NULL DEFAULT 0,
    PRIMARY KEY (message_id, session_id, vm_id, ts),
    KEY idx_session (session_id, vm_id, seq_num),
    KEY idx_ts (ts),
    FULLTEXT KEY ft_content_text (content_text)
  ) ${COMPRESSED}`,

  `CREATE TABLE IF NOT EXISTS agent_history (
    session_id      VARCHAR(64)  NOT NULL,
    vm_id           VARCHAR(64)  NOT NULL,
    source          VARCHAR(16)  NOT NULL DEFAULT '',
    ts              DATETIME     NOT NULL,
    project         VARCHAR(512) DEFAULT NULL,
    display_text    MEDIUMTEXT   DEFAULT NULL,
    pasted_contents MEDIUMTEXT   DEFAULT NULL,
    PRIMARY KEY (session_id, vm_id, source, ts),
    KEY idx_ts (ts),
    FULLTEXT KEY ft_display_text (display_text)
  ) ${COMPRESSED}`,

  `CREATE TABLE IF NOT EXISTS agent_tasks (
    task_id         VARCHAR(64)  NOT NULL,
    session_id      VARCHAR(64)  NOT NULL,
    vm_id           VARCHAR(64)  NOT NULL,
    task_number     INT          DEFAULT NULL,
    subject         MEDIUMTEXT   DEFAULT NULL,
    description     MEDIUMTEXT   DEFAULT NULL,
    task_status     VARCHAR(32)  DEFAULT NULL,
    blocks          MEDIUMTEXT   DEFAULT NULL,
    blocked_by      MEDIUMTEXT   DEFAULT NULL,
    synced_at       DATETIME     NOT NULL,
    PRIMARY KEY (task_id, session_id, vm_id),
    KEY idx_session (session_id, vm_id),
    FULLTEXT KEY ft_subject_desc (subject, description)
  ) ${COMPRESSED}`,

  `CREATE TABLE IF NOT EXISTS agent_todos (
    todo_id         VARCHAR(128) NOT NULL,
    vm_id           VARCHAR(64)  NOT NULL,
    content         MEDIUMTEXT   DEFAULT NULL,
    todo_status     VARCHAR(32)  DEFAULT NULL,
    priority        VARCHAR(16)  DEFAULT NULL,
    items_json      MEDIUMTEXT   DEFAULT NULL,
    synced_at       DATETIME     NOT NULL,
    PRIMARY KEY (todo_id, vm_id),
    FULLTEXT KEY ft_content (content)
  ) ${COMPRESSED}`,

  `CREATE TABLE IF NOT EXISTS sync_state (
    vm_id           VARCHAR(64)  NOT NULL,
    source          VARCHAR(16)  NOT NULL,
    file_path       VARCHAR(512) NOT NULL,
    file_size       BIGINT       NOT NULL DEFAULT 0,
    file_mtime      DATETIME     DEFAULT NULL,
    lines_processed BIGINT       NOT NULL DEFAULT 0,
    last_synced_at  DATETIME     NOT NULL,
    PRIMARY KEY (vm_id, source, file_path)
  ) ${PLAIN}`,

  `CREATE TABLE IF NOT EXISTS session_summaries (
    session_id      VARCHAR(64)  NOT NULL,
    vm_id           VARCHAR(64)  NOT NULL,
    summary         MEDIUMTEXT   DEFAULT NULL,
    model           VARCHAR(128) NOT NULL DEFAULT '',
    msg_count       INT          NOT NULL DEFAULT 0,
    last_message_ts DATETIME     DEFAULT NULL,
    updated_at      DATETIME     NOT NULL,
    PRIMARY KEY (session_id, vm_id),
    FULLTEXT KEY ft_summary (summary)
  ) ${COMPRESSED}`,
]

export async function ensureSchema() {
  const pool = getPool()
  for (const ddl of DDL) {
    const tableName = ddl.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1] ?? 'unknown'
    try {
      await pool.query(ddl)
      console.log(`[schema] table ${tableName} ready`)
    } catch (err) {
      console.error(`[schema] failed to create ${tableName}:`, err.message)
      throw err
    }
  }
}

// Allow running standalone: node src/db/schema.js
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await ensureSchema()
    console.log('[schema] all tables created')
    process.exit(0)
  } catch {
    process.exit(1)
  }
}
