/** Absolute deadlines: Retry-After is a floor, never capped to a shorter wait. */
export function retryAt(header: string | null, now = Date.now(), attempt = 0, random = Math.random) {
  if (header && /^\d+(?:\.\d+)?$/.test(header.trim())) {
    const seconds=Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return now+Math.ceil(seconds*1000);
  }
  if (header && !/^\s*[-+]?\d/.test(header)) {
    const date=Date.parse(header);
    if (Number.isFinite(date)) return Math.max(now,date);
  }
  return now+Math.ceil(Math.min(30000,1000*2**Math.min(attempt,5))*(1+Math.max(0,Math.min(1,random()))));
}
export class UpstreamError extends Error {
  code: string; outcome: 'rejected' | 'uncertain' | 'terminal'; status: number; notBefore: number;
  constructor(code: string, outcome: 'rejected' | 'uncertain' | 'terminal', status = 0, notBefore = 0) {
    super(outcome === 'uncertain' ? 'The provider may have accepted this request. We are checking its status; do not submit it again.'
      : 'The audio service could not complete this request. Your successful-split allowance has not been used.');
    this.code=code;this.outcome=outcome;this.status=status;this.notBefore=notBefore;
  }
}
export async function setCooldown(db: D1Database, provider: string, until: number) {
  await db.prepare(`INSERT INTO provider_cooldowns(provider,until_ms) VALUES(?,?)
    ON CONFLICT(provider) DO UPDATE SET until_ms=MAX(until_ms,excluded.until_ms)`).bind(provider,until).run();
}
export async function cooldown(db: D1Database, provider: string, now=Date.now()) {
  const row=await db.prepare('SELECT until_ms FROM provider_cooldowns WHERE provider=?').bind(provider).first<{until_ms:number}>();
  return Math.max(now,row?.until_ms ?? now);
}
