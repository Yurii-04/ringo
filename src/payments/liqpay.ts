import { createHash, timingSafeEqual } from 'node:crypto';

export const LIQPAY_CHECKOUT_URL = 'https://www.liqpay.ua/api/3/checkout';

/** signature = base64(sha1(private_key + data + private_key)) */
export function liqpaySignature(data: string, privateKey: string): string {
  return createHash('sha1').update(privateKey + data + privateKey).digest('base64');
}

export function encodeLiqpayData(params: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(params), 'utf8').toString('base64');
}

export function verifyLiqpaySignature(data: string, signature: string, privateKey: string): boolean {
  if (!data || !signature) return false;
  const expected = Buffer.from(liqpaySignature(data, privateKey));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface LiqpayCallbackData {
  order_id?: string;
  status?: string;
  amount?: number;
  currency?: string;
  payment_id?: number | string;
  public_key?: string;
}

export function decodeLiqpayData(data: string): LiqpayCallbackData {
  return JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as LiqpayCallbackData;
}
