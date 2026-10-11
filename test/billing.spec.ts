import { TransactionType } from '@prisma/client';
import { BillingService } from '../src/billing/billing.service';
import { DomainError } from '../src/common/domain-error';
import { mockPrisma, PrismaMock } from './helpers';

describe('BillingService', () => {
  let prisma: PrismaMock;
  let billing: BillingService;

  beforeEach(() => {
    prisma = mockPrisma();
    billing = new BillingService(prisma as never);
  });

  describe('chargeForCall', () => {
    it('decrements balance conditionally and writes a ledger entry', async () => {
      prisma.user.updateMany.mockResolvedValue({ count: 1 });
      await billing.chargeForCall(prisma as never, 'u1', 'c1', 4900);
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: 'u1', balance: { gte: 4900 } },
        data: { balance: { decrement: 4900 } },
      });
      expect(prisma.transaction.create).toHaveBeenCalledWith({
        data: { userId: 'u1', type: TransactionType.CALL_CHARGE, amount: -4900, callId: 'c1' },
      });
    });

    it('throws INSUFFICIENT_FUNDS and writes nothing when balance is too low', async () => {
      prisma.user.updateMany.mockResolvedValue({ count: 0 });
      const err = await billing.chargeForCall(prisma as never, 'u1', 'c1', 4900).catch((e) => e);
      expect(err).toBeInstanceOf(DomainError);
      expect(err.code).toBe('INSUFFICIENT_FUNDS');
      expect(prisma.transaction.create).not.toHaveBeenCalled();
    });
  });

  describe('refundCall', () => {
    it('returns the call price once', async () => {
      prisma.call.updateMany.mockResolvedValue({ count: 1 });
      prisma.call.findUniqueOrThrow.mockResolvedValue({ userId: 'u1', price: 4900 });
      await expect(billing.refundCall('c1', 'no answer')).resolves.toBe(true);
      expect(prisma.call.updateMany).toHaveBeenCalledWith({
        where: { id: 'c1', refunded: false },
        data: { refunded: true },
      });
      expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { balance: { increment: 4900 } } });
      expect(prisma.transaction.create).toHaveBeenCalledWith({
        data: { userId: 'u1', type: TransactionType.REFUND, amount: 4900, callId: 'c1', comment: 'no answer' },
      });
    });

    it('is idempotent: a second refund does nothing', async () => {
      prisma.call.updateMany.mockResolvedValue({ count: 0 });
      await expect(billing.refundCall('c1', 'dup')).resolves.toBe(false);
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.transaction.create).not.toHaveBeenCalled();
    });
  });

  describe('credit', () => {
    it('credits a top-up', async () => {
      await billing.credit(prisma as never, 'u1', 10000, 'TOPUP', { paymentId: 'p1' });
      expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { balance: { increment: 10000 } } });
      expect(prisma.transaction.create).toHaveBeenCalledWith({
        data: { userId: 'u1', type: TransactionType.TOPUP, amount: 10000, paymentId: 'p1', comment: undefined },
      });
    });

    it('does not let an admin adjustment drive the balance negative', async () => {
      prisma.user.updateMany.mockResolvedValue({ count: 0 });
      await expect(billing.credit(prisma as never, 'u1', -5000, 'ADMIN_ADJUSTMENT')).rejects.toBeInstanceOf(DomainError);
      expect(prisma.transaction.create).not.toHaveBeenCalled();
    });

    it('rejects zero and fractional amounts', async () => {
      await expect(billing.credit(prisma as never, 'u1', 0, 'TOPUP')).rejects.toThrow();
      await expect(billing.credit(prisma as never, 'u1', 10.5, 'TOPUP')).rejects.toThrow();
    });
  });
});
