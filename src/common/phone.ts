/**
 * Ukrainian mobile operator codes (the two digits after +380).
 * Landlines and short/service numbers are intentionally not allowed.
 */
export const UA_MOBILE_CODES = new Set([
  '39', '50', '63', '66', '67', '68', '73', '75', '77', '91', '92', '93', '94', '95', '96', '97', '98', '99',
]);

/**
 * Normalizes user input like "067 123 45 67", "+38 (067) 123-45-67",
 * "380671234567" to E.164 "+380671234567". Returns null when the number
 * is not a valid Ukrainian mobile number.
 */
export function normalizeUaPhone(input: string): string | null {
  const trimmed = input.trim();
  if (!/^[+\d\s()\-.]+$/.test(trimmed)) return null;
  let digits = trimmed.replace(/\D/g, '');

  if (digits.length === 10 && digits.startsWith('0')) digits = `38${digits}`;
  else if (digits.length === 11 && digits.startsWith('80')) digits = `3${digits}`;

  if (!/^380\d{9}$/.test(digits)) return null;
  if (!UA_MOBILE_CODES.has(digits.slice(3, 5))) return null;
  return `+${digits}`;
}

/** +380671234567 -> +380 67 ***-**-67 (for logs and notifications). */
export function maskPhone(e164: string): string {
  return `${e164.slice(0, 4)} ${e164.slice(4, 6)} ***-**-${e164.slice(-2)}`;
}
