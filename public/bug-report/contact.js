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
  const [local, domain, extra] = contact.email.split('@');
  if (contact.email.length > 254 || !local || local.length > 64 || extra !== undefined
    || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || /^\.|\.$|\.\./.test(local)
    || !domain || !/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+edu$/i.test(domain)) {
    errors.email = 'Use a valid .edu email address.';
  }
  contact.email = contact.email.toLowerCase();
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, contact };
}
