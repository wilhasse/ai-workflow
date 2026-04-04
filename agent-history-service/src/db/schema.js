import { getPool } from './connection.js'

const DDL = [
  `CREATE TABLE IF NOT EXISTS agent_sessions (
    session_id      VARCHAR(64)   NOT NULL,
    vm_id           VARCHAR(64)   NOT NULL,
    started_at      DATETIME      NOT NULL,
    source          VARCHAR(16)   NOT NULL DEFAULT '',
    project         VARCHAR(512)  DEFAULT NULL,
    display_text    STRING        DEFAULT NULL,
    session_meta    STRING        DEFAULT NULL,
    message_count   INT           NOT NULL DEFAULT 0,
    last_synced_at  DATETIME      NOT NULL,
    INDEX idx_display_text (display_text) USING INVERTED PROPERTIES("parser" = "unicode", "support_phrase" = "true"),
    INDEX idx_project (project) USING INVERTED
  )
  UNIQUE KEY(session_id, vm_id, started_at)
  PARTITION BY RANGE(started_at) ()
  DISTRIBUTED BY HASH(session_id) BUCKETS 8
  PROPERTIES (
    "replication_num" = "1",
    "dynamic_partition.enable" = "true",
    "dynamic_partition.time_unit" = "MONTH",
    "dynamic_partition.start" = "-24",
    "dynamic_partition.end" = "1",
    "dynamic_partition.prefix" = "p",
    "dynamic_partition.buckets" = "8",
    "dynamic_partition.create_history_partition" = "true"
  )`,

  `CREATE TABLE IF NOT EXISTS agent_messages (
    message_id      VARCHAR(64)   NOT NULL,
    session_id      VARCHAR(64)   NOT NULL,
    vm_id           VARCHAR(64)   NOT NULL,
    ts              DATETIME      NOT NULL,
    source          VARCHAR(16)   NOT NULL DEFAULT '',
    msg_type        VARCHAR(32)   NOT NULL DEFAULT '',
    msg_role        VARCHAR(16)   NOT NULL DEFAULT '',
    content_text    STRING        DEFAULT NULL,
    content_json    STRING        DEFAULT NULL,
    parent_uuid     VARCHAR(64)   DEFAULT NULL,
    seq_num         INT           NOT NULL DEFAULT 0,
    INDEX idx_content_text (content_text) USING INVERTED PROPERTIES("parser" = "unicode", "support_phrase" = "true"),
    INDEX idx_msg_type (msg_type) USING INVERTED
  )
  UNIQUE KEY(message_id, session_id, vm_id, ts)
  PARTITION BY RANGE(ts) ()
  DISTRIBUTED BY HASH(session_id) BUCKETS 16
  PROPERTIES (
    "replication_num" = "1",
    "dynamic_partition.enable" = "true",
    "dynamic_partition.time_unit" = "MONTH",
    "dynamic_partition.start" = "-24",
    "dynamic_partition.end" = "1",
    "dynamic_partition.prefix" = "p",
    "dynamic_partition.buckets" = "16",
    "dynamic_partition.create_history_partition" = "true"
  )`,

  `CREATE TABLE IF NOT EXISTS agent_history (
    session_id      VARCHAR(64)   NOT NULL,
    vm_id           VARCHAR(64)   NOT NULL,
    source          VARCHAR(16)   NOT NULL DEFAULT '',
    ts              DATETIME      NOT NULL,
    project         VARCHAR(512)  DEFAULT NULL,
    display_text    STRING        DEFAULT NULL,
    pasted_contents STRING        DEFAULT NULL,
    INDEX idx_display (display_text) USING INVERTED PROPERTIES("parser" = "unicode", "support_phrase" = "true")
  )
  UNIQUE KEY(session_id, vm_id, source, ts)
  DISTRIBUTED BY HASH(session_id) BUCKETS 4
  PROPERTIES ("replication_num" = "1")`,

  `CREATE TABLE IF NOT EXISTS agent_tasks (
    task_id         VARCHAR(64)   NOT NULL,
    session_id      VARCHAR(64)   NOT NULL,
    vm_id           VARCHAR(64)   NOT NULL,
    task_number     INT           DEFAULT NULL,
    subject         STRING        DEFAULT NULL,
    description     STRING        DEFAULT NULL,
    task_status     VARCHAR(32)   DEFAULT NULL,
    blocks          STRING        DEFAULT NULL,
    blocked_by      STRING        DEFAULT NULL,
    synced_at       DATETIME      NOT NULL,
    INDEX idx_subject (subject) USING INVERTED PROPERTIES("parser" = "unicode"),
    INDEX idx_description (description) USING INVERTED PROPERTIES("parser" = "unicode")
  )
  UNIQUE KEY(task_id, session_id, vm_id)
  DISTRIBUTED BY HASH(session_id) BUCKETS 4
  PROPERTIES ("replication_num" = "1")`,

  `CREATE TABLE IF NOT EXISTS agent_todos (
    todo_id         VARCHAR(128)  NOT NULL,
    vm_id           VARCHAR(64)   NOT NULL,
    content         STRING        DEFAULT NULL,
    todo_status     VARCHAR(32)   DEFAULT NULL,
    priority        VARCHAR(16)   DEFAULT NULL,
    items_json      STRING        DEFAULT NULL,
    synced_at       DATETIME      NOT NULL,
    INDEX idx_content (content) USING INVERTED PROPERTIES("parser" = "unicode")
  )
  UNIQUE KEY(todo_id, vm_id)
  DISTRIBUTED BY HASH(todo_id) BUCKETS 4
  PROPERTIES ("replication_num" = "1")`,

  `CREATE TABLE IF NOT EXISTS sync_state (
    vm_id           VARCHAR(64)   NOT NULL,
    source          VARCHAR(16)   NOT NULL,
    file_path       VARCHAR(1024) NOT NULL,
    file_size       BIGINT        NOT NULL DEFAULT 0,
    file_mtime      DATETIME      DEFAULT NULL,
    lines_processed BIGINT        NOT NULL DEFAULT 0,
    last_synced_at  DATETIME      NOT NULL
  )
  UNIQUE KEY(vm_id, source, file_path)
  DISTRIBUTED BY HASH(vm_id) BUCKETS 4
  PROPERTIES ("replication_num" = "1")`,
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
