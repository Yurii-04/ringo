import { PaymentStatus } from '@prisma/client';
import { BillingService } from '../src/billing/billing.service';
import { decodeLiqpayData, encodeLiqpayData, liqpaySignature, verifyLiqpaySignature } from '../src/payments/liqpay';
import { PaymentsService } from '../src/payments/payments.service';
import { mockPrisma, PrismaMock, testConfig } from './helpers';

describe('LiqPay signature', () => {
  it('matches the documented algorithm base64(sha1(priv + data + priv))', () => {
    // Reference value computed independently: sha1("priv" + "ZGF0YQ==" + "priv")
    const data = 'ZGF0YQ==';
    const sig = liqpaySignature(data, 'priv');
    expect(sig).toBe(require('node:crypto').createHash('sha1').update('privZGF0YQ==priv').digest('base64'));
    expect(verifyLiqpaySignature(data, sig, 'priv')).toBe(true);
    expect(verifyLiqpaySignature(data, sig, 'other')).toBe(false);
    expect(verifyLiqpaySignature(data, '', 'priv')).toBe(false);
  });
});

describe('PaymentsService', () => {
  let prisma: PrismaMock;
  let billing: jest.Mocked<Pick<BillingService, 'credit'>>;
  let notifications: { sendText: jest.Mock };
  let service: PaymentsService;
  const config = testConfig();

  const callback = (payload: Record<string, unknown>) => {
    const data = encodeLiqpayData(payload);
    return { data, signature: liqpaySignature(data, config.LIQPAY_PRIVATE_KEY) };
  };

  beforeEach(() => {
    prisma = mockPrisma();
    billing = { credit: jest.fn() };
    notifications = { sendText: jest.fn() };
    service = new PaymentsService(config, prisma as never, billing as never, notifications as never);
    prisma.payment.findUnique.mockResolvedValue({ id: 'p1', userId: 'u1', amount: 10000, status: PaymentStatus.PENDING });
    prisma.user.findUniqueOrThrow.mockResolvedValue({ telegramId: 42n, balance: 10000 });
  });

  it('builds a signed checkout URL', async () => {
    prisma.payment.create.mockResolvedValue({ id: 'p1' });
    const { url } = await service.createTopUp('u1', 100);
    const params = new URL(url).searchParams;
    const data = decodeLiqpayData(params.get('data')!);
    expect(data).toMatchObject({ amount: 100, currency: 'UAH', order_id: 'p1', action: 'pay', version: 3 });
    expect(verifyLiqpaySignature(params.get('data')!, params.get('signature')!, config.LIQPAY_PRIVATE_KEY)).toBe(true);
  });

  it('rejects unsupported top-up amounts', async () => {
    await expect(service.createTopUp('u1', 7)).rejects.toThrow();
  });

  it('rejects a callback with a bad signature', async () => {
    const { data } = callback({ order_id: 'p1', status: 'success', amount: 100, currency: 'UAH' });
    await expect(service.handleCallback(data, 'forged')).resolves.toBe(false);
    expect(billing.credit).not.toHaveBeenCalled();
  });

  it('credits the balance once on success', async () => {
    prisma.payment.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const { data, signature } = callback({ order_id: 'p1', status: 'success', amount: 100, currency: 'UAH', payment_id: 7 });

    await expect(service.handleCallback(data, signature)).resolves.toBe(true);
    await expect(service.handleCallback(data, signature)).resolves.toBe(true); // LiqPay retry

    expect(billing.credit).toHaveBeenCalledTimes(1);
    expect(billing.credit).toHaveBeenCalledWith(prisma, 'u1', 10000, 'TOPUP', { paymentId: 'p1' });
    expect(notifications.sendText).toHaveBeenCalledTimes(1);
  });

  it('does not credit when the paid amount differs from the order', async () => {
    const { data, signature } = callback({ order_id: 'p1', status: 'success', amount: 1, currency: 'UAH' });
    await service.handleCallback(data, signature);
    expect(billing.credit).not.toHaveBeenCalled();
  });

  it('marks failed payments without crediting', async () => {
    prisma.payment.updateMany.mockResolvedValue({ count: 1 });
    const { data, signature } = callback({ order_id: 'p1', status: 'failure', amount: 100, currency: 'UAH' });
    await service.handleCallback(data, signature);
    expect(prisma.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: PaymentStatus.FAILED, rawStatus: 'failure' } }),
    );
    expect(billing.credit).not.toHaveBeenCalled();
  });

  it('accepts the sandbox status only in sandbox mode', async () => {
    const prod = new PaymentsService(testConfig({ LIQPAY_SANDBOX: 'false' }), prisma as never, billing as never, notifications as never);
    const { data, signature } = callback({ order_id: 'p1', status: 'sandbox', amount: 100, currency: 'UAH' });
    await prod.handleCallback(data, signature);
    expect(billing.credit).not.toHaveBeenCalled();
  });
});
