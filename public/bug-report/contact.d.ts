export type GuestContact = { firstName: string; lastName: string; email: string };
export function parseGuestContact(value: unknown): { ok: true; contact: GuestContact } | { ok: false; errors: Partial<Record<keyof GuestContact,string>> };
