/** Shared browser/server validation. An .edu address is contact information, not verified identity. */
export function parseGuestContact(value) {
  const fields = value && typeof value === 'object' ? value : {};
  const contact = Object.fromEntries(['firstName', 'lastName', 'email'].map(key => [key,
    typeof fields[key] === 'string' ? fields[key].trim() : '',
  ]));
  const errors = {};
  for (const [key, label] of [['firstName', 'first name'], ['lastName', 'last name']]) {
    if (!/^[\p{L}\p{M}][\p{L}\p{M} .'’\-]{0,79}$/u.test(contact[key])) errors[key] = `Enter your ${label} (up to 80 characters).`;
  }
  const email = reportEmail(contact.email);
  if (!email) errors.email = 'Use a valid .edu email address.';
  else contact.email = email;
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, contact };
}

/** Only server-verified CUNY Login claims may use a non-.edu address. */
export function reportEmail(value, eduOnly = true) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  const [local, domain, extra] = email.split('@');
  if (email.length > 254 || !local || local.length > 64 || extra !== undefined
    || !/^[A-Za-z0-9.!#$%&'*+/=?^_\x60{|}~-]+$/.test(local) || /^\.|\.$|\.\./.test(local)
    || !domain || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
    || (eduOnly && !domain.endsWith('.edu'))) return null;
  return email;
}
