-- Bind :since_ms and :now_ms. Read-only; no identities or conversation content.
SELECT kind,
  COUNT(*) AS operations,
  SUM(state='succeeded') AS recorded_successes,
  SUM(state IN ('failed','partial') OR
    (state='cancelled' AND COALESCE(error_code,'') NOT IN ('cached_response','conversation_reset')) OR
    (state NOT IN ('succeeded','failed','partial','cancelled') AND created_at<=:now_ms-120000)) AS failures,
  SUM(state='cancelled' AND error_code='conversation_reset') AS explicit_cancellations,
  SUM(state='cancelled' AND error_code='cached_response') AS cached_operations,
  SUM(state NOT IN ('succeeded','failed','partial','cancelled') AND created_at>:now_ms-120000) AS pending
FROM app_operations
WHERE kind IN ('guide','chat') AND created_at>=:since_ms AND created_at<=:now_ms
GROUP BY kind;

-- Rejections remain visible and separate. Provider capacity failures belong
-- to operation outcomes above; they must not be subtracted as quota exclusions.
SELECT event_type,code,http_status,COUNT(*) AS rejected_requests
FROM usage_events
WHERE event_type IN ('guide_request','chat_request') AND at>=:since_ms AND at<=:now_ms
GROUP BY event_type,code,http_status;
