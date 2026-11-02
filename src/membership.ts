export interface MembershipReceipt {
  ok: true;
  accessRole: 'member' | 'admin';
  budgetScope: 'person' | 'person-plus' | 'admin';
  revision: number;
  expiresAt: string;
}

/** Requests and queued personal work use the same current Admission contract. */
export function currentMembership(value: unknown, now = Date.now()): MembershipReceipt | 'denied' | null {
  if (!value || typeof value !== 'object') return null;
  const membership = value as Record<string, unknown>;
  if (membership.ok === false && membership.code === 'not_admitted') return 'denied';
  if (membership.ok !== true || !['member', 'admin'].includes(String(membership.accessRole)) ||
      !['person', 'person-plus', 'admin'].includes(String(membership.budgetScope)) ||
      (membership.accessRole === 'admin') !== (membership.budgetScope === 'admin') ||
      !Number.isSafeInteger(membership.revision) || Number(membership.revision) < 0 ||
      typeof membership.expiresAt !== 'string' || !Number.isFinite(Date.parse(membership.expiresAt))) return null;
  if (Date.parse(membership.expiresAt) <= now) return 'denied';
  return membership as unknown as MembershipReceipt;
}
