import { createHmac, timingSafeEqual } from 'node:crypto';

export const ELEVENLABS_SIGNATURE_HEADER = 'elevenlabs-signature';
/** ElevenLabs recommends rejecting events older than 30 minutes. */
export const SIGNATURE_TOLERANCE_SEC = 30 * 60;

/**
 * Verifies the `ElevenLabs-Signature: t=<unix>,v0=<hex hmac>` header where
 * v0 = HMAC-SHA256(secret, `${t}.${rawBody}`).
 */
export function verifyElevenLabsSignature(
  rawBody: Buffer | string,
  header: string | undefined,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const idx = p.indexOf('=');
      return [p.slice(0, idx).trim(), p.slice(idx + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  const sig = parts.v0;
  if (!Number.isFinite(t) || !sig || !/^[0-9a-f]+$/i.test(sig)) return false;
  if (Math.abs(nowSec - t) > SIGNATURE_TOLERANCE_SEC) return false;

  const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(sig, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
