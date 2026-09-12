-- Run once after ensureSchema adds last_activity, using the OCI app connection.
-- Derived tables keep only per-session timestamps and require no temporary-table grant.
INSERT INTO agent_sessions (session_id, vm_id, started_at, source, message_count, last_synced_at, last_activity, session_meta)
SELECT r.session_id, r.vm_id, r.first_message, r.source, 0, UTC_TIMESTAMP(), r.last_message, '{"message_derived":true}'
FROM (
  SELECT session_id, vm_id, MIN(ts) AS first_message, MAX(ts) AS last_message, MAX(source) AS source
  FROM agent_messages GROUP BY session_id, vm_id
) r
WHERE NOT EXISTS (SELECT 1 FROM agent_sessions s WHERE s.session_id = r.session_id AND s.vm_id = r.vm_id);
UPDATE agent_sessions s LEFT JOIN (
  SELECT session_id, vm_id, MAX(ts) AS last_message
  FROM agent_messages GROUP BY session_id, vm_id
) r ON r.session_id = s.session_id AND r.vm_id = s.vm_id
SET s.last_activity = GREATEST(COALESCE(s.last_activity, s.started_at), COALESCE(r.last_message, s.started_at));
SELECT COUNT(*) AS sessions_missing_activity FROM agent_sessions WHERE last_activity IS NULL;
