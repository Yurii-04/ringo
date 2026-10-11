import { Inject, Injectable, Logger } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';
import { BillingService } from '../billing/billing.service';
import { uah } from '../common/money';
import { APP_CONFIG, AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from '../telegram/notification.service';
import {
  LIQPAY_CHECKOUT_URL,
  LiqpayCallbackData,
  decodeLiqpayData,
  encodeLiqpayData,
  liqpaySignature,
  verifyLiqpaySignature,
} from './liqpay';

const FAILED_STATUSES = new Set(['failure', 'error', 'reversed']);

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly notifications: NotificationService,
  ) {}

  /** Creates a pending payment and returns a LiqPay checkout link. */
  async createTopUp(userId: string, amountUah: number): Promise<{ paymentId: string; url: string }> {
    if (!this.config.TOPUP_OPTIONS_UAH.includes(amountUah)) throw new Error(`Unsupported top-up amount ${amountUah}`);
    const payment = await this.prisma.payment.create({ data: { userId, amount: amountUah * 100 } });
    const data = encodeLiqpayData({
      version: 3,
      public_key: this.config.LIQPAY_PUBLIC_KEY,
      action: 'pay',
      amount: amountUah,
      currency: 'UAH',
      description: `Поповнення балансу Ringo на ${amountUah} грн`,
      order_id: payment.id,
      server_url: `${this.config.PUBLIC_BASE_URL}/payments/liqpay/callback`,
      language: 'uk',
      ...(this.config.LIQPAY_SANDBOX ? { sandbox: 1 } : {}),
    });
    const signature = liqpaySignature(data, this.config.LIQPAY_PRIVATE_KEY);
    const url = `${LIQPAY_CHECKOUT_URL}?${new URLSearchParams({ data, signature }).toString()}`;
    return { paymentId: payment.id, url };
  }

  /**
   * Handles LiqPay server-to-server callback. Idempotent: the balance is credited
   * only on the PENDING -> SUCCESS transition.
   * @returns false when the signature is invalid.
   */
  async handleCallback(data: string, signature: string): Promise<boolean> {
    if (!verifyLiqpaySignature(data, signature, this.config.LIQPAY_PRIVATE_KEY)) return false;
    let payload: LiqpayCallbackData;
    try {
      payload = decodeLiqpayData(data);
    } catch {
      return false;
    }
    const orderId = payload.order_id;
    const payment = orderId ? await this.prisma.payment.findUnique({ where: { id: orderId } }) : null;
    if (!payment) {
      this.logger.warn(`LiqPay callback for unknown order ${orderId}`);
      return true;
    }

    const isSuccess = payload.status === 'success' || (this.config.LIQPAY_SANDBOX && payload.status === 'sandbox');
    if (isSuccess) {
      const paidKopecks = Math.round(Number(payload.amount) * 100);
      if (payload.currency !== 'UAH' || paidKopecks !== payment.amount) {
        this.logger.error(`LiqPay amount mismatch for ${payment.id}: ${payload.amount} ${payload.currency}`);
        await this.prisma.payment.update({ where: { id: payment.id }, data: { rawStatus: `mismatch:${payload.status}` } });
        return true;
      }
      const credited = await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.payment.updateMany({
          where: { id: payment.id, status: PaymentStatus.PENDING },
          data: { status: PaymentStatus.SUCCESS, rawStatus: payload.status, providerRef: String(payload.payment_id ?? '') },
        });
        if (count === 0) return false;
        await this.billing.credit(tx, payment.userId, payment.amount, 'TOPUP', { paymentId: payment.id });
        return true;
      });
      if (credited) {
        const user = await this.prisma.user.findUniqueOrThrow({ where: { id: payment.userId } });
        await this.notifications.sendText(
          user.telegramId,
          `✅ Баланс поповнено на ${uah(payment.amount)}. Поточний баланс: ${uah(user.balance)}.`,
        );
      }
    } else if (FAILED_STATUSES.has(payload.status ?? '')) {
      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.FAILED, rawStatus: payload.status },
      });
    } else {
      await this.prisma.payment.update({ where: { id: payment.id }, data: { rawStatus: payload.status } });
    }
    return true;
  }
}
