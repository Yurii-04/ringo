import { Injectable, Logger } from '@nestjs/common';
import { TransactionType } from '@prisma/client';
import { DomainError } from '../common/domain-error';
import { uah } from '../common/money';
import { PrismaService } from '../prisma/prisma.service';
import { Tx } from '../prisma/types';

/**
 * Balance ledger. The `User.balance` column is a cached sum of `Transaction.amount`;
 * every change goes through this service inside a DB transaction.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getBalance(userId: string): Promise<number> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { balance: true } });
    return user.balance;
  }

  /**
   * Atomically charges the user for a call. Must run inside the transaction that
   * creates the call. The conditional update makes overdrafts impossible even
   * under concurrent requests.
   */
  async chargeForCall(tx: Tx, userId: string, callId: string, amount: number): Promise<void> {
    const { count } = await tx.user.updateMany({
      where: { id: userId, balance: { gte: amount } },
      data: { balance: { decrement: amount } },
    });
    if (count === 0) {
      throw new DomainError('INSUFFICIENT_FUNDS', `Недостатньо коштів. Вартість дзвінка — ${uah(amount)}.`);
    }
    await tx.transaction.create({
      data: { userId, type: TransactionType.CALL_CHARGE, amount: -amount, callId },
    });
  }

  /**
   * Returns the call price to the customer. Idempotent: the `refunded` flag is
   * flipped with a conditional update, and (callId, REFUND) is unique in the ledger.
   * @returns true if money was returned by this invocation.
   */
  async refundCall(callId: string, comment: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.call.updateMany({
        where: { id: callId, refunded: false },
        data: { refunded: true },
      });
      if (count === 0) return false;

      const call = await tx.call.findUniqueOrThrow({ where: { id: callId }, select: { userId: true, price: true } });
      await tx.user.update({ where: { id: call.userId }, data: { balance: { increment: call.price } } });
      await tx.transaction.create({
        data: { userId: call.userId, type: TransactionType.REFUND, amount: call.price, callId, comment },
      });
      this.logger.log(`Refunded ${call.price} for call ${callId}: ${comment}`);
      return true;
    });
  }

  /** Credits a successful top-up or an admin adjustment. */
  async credit(
    tx: Tx,
    userId: string,
    amount: number,
    type: 'TOPUP' | 'ADMIN_ADJUSTMENT',
    meta: { paymentId?: string; comment?: string } = {},
  ): Promise<void> {
    if (!Number.isInteger(amount) || amount === 0) throw new Error(`Invalid credit amount: ${amount}`);
    if (amount < 0) {
      const { count } = await tx.user.updateMany({
        where: { id: userId, balance: { gte: -amount } },
        data: { balance: { increment: amount } },
      });
      if (count === 0) throw new DomainError('INSUFFICIENT_FUNDS', 'Баланс не може стати від’ємним.');
    } else {
      await tx.user.update({ where: { id: userId }, data: { balance: { increment: amount } } });
    }
    await tx.transaction.create({
      data: { userId, type: TransactionType[type], amount, paymentId: meta.paymentId, comment: meta.comment },
    });
  }
}
