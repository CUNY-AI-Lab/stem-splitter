/** Browser transport primitives only. Doorway remains the session authority. */
export const LOGIN_TTL_MS = 600000;
const proof = /^[A-Za-z0-9_-]{43}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function uniqueCookie(request, name) {
  const values = (request.headers.get('cookie') || '').split(';').map(p => p.trim()).filter(p => p.startsWith(name + '='));
  return values.length === 1 ? values[0].slice(name.length + 1) : '';
}
/** A structural check is never authentication or proof of current admission. */
export function validSessionToken(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  return parts.length === 2 && uuid.test(parts[0]) && proof.test(parts[1]);
}
export function parseLoginTransaction(raw, params, now = Date.now()) {
  if (!raw || raw.length > 1500) return null;
  let saved;
  try { saved = JSON.parse(decodeURIComponent(raw)); } catch { return null; }
  if (!saved || typeof saved !== 'object' || typeof saved.state !== 'string' || typeof saved.verifier !== 'string'
      || !proof.test(saved.state) || !proof.test(saved.verifier)
      || params.getAll('state').length !== 1 || params.getAll('code').length !== 1
      || saved.state !== params.get('state') || !uuid.test(params.get('code') || '')
      || !Number.isSafeInteger(saved.expiresAt) || saved.expiresAt <= now || saved.expiresAt > now + LOGIN_TTL_MS) return null;
  return saved;
}
