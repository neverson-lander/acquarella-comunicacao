function canonicalPhone(value) {
  const digits = String(value ?? '');
  if (!/^\d{10,15}$/.test(digits)) return null;
  // Meta may identify Brazilian mobile numbers using the legacy eight-digit form.
  if (/^55[1-9]\d9[6-9]\d{7}$/.test(digits)) return digits.slice(0, 4) + digits.slice(5);
  return digits;
}

export function sameWhatsAppPhone(sender, configured) {
  const left = canonicalPhone(sender), right = canonicalPhone(configured);
  return left !== null && right !== null && left === right;
}

export function knownWhatsAppRecipient(recipient, configuredTeamPhone) {
  return sameWhatsAppPhone(recipient, configuredTeamPhone) ? configuredTeamPhone : recipient;
}
