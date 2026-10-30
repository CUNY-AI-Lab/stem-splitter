// Only fixed diagnostic vocabulary may cross the provider/UI/log boundary.
// Never include an exception message, provider body, prompt or credential.
const CODES = new Set([
  'assistant_unavailable', 'empty_response', 'incomplete_response', 'invalid_tool_calls',
  'upstream_timeout', 'upstream_unavailable', 'upstream_rate_limited', 'model_unavailable',
  'model_cooldown', 'quota_exceeded', 'quota_unavailable', 'rate_limit_unknown',
  'upstream_auth_error', 'upstream_payment_required', 'invalid_request', 'invalid_credential',
  'authentication_required', 'admission_required', 'policy_denied', 'request_cancelled',
]);
export function assistantDiagnosticCode(value: unknown): string {
  return typeof value === 'string' && CODES.has(value) ? value : 'assistant_unavailable';
}
export function assistantRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) ? value : undefined;
}
export function assistantRetrySeconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 7 * 86400 ? Math.ceil(value) : undefined;
}
export function gatewayRetrySeconds(value: unknown, now = Date.now()): number | undefined {
  if (typeof value === 'number') return assistantRetrySeconds(value);
  if (typeof value !== 'string' || value.length > 80) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return assistantRetrySeconds(Number(value));
  if (!/^[A-Za-z]{3}, /.test(value)) return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? assistantRetrySeconds(Math.max(0, (at - now) / 1000)) : undefined;
}
