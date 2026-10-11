import { Injectable } from '@nestjs/common';
import { CallStatus, PaymentStatus, TransactionType } from '@prisma/client';
import { BillingService } from '../billing/billing.service';
import { BlocklistService } from '../blocklist/blocklist.service';
import { uah } from '../common/money';
import { normalizeUaPhone } from '../common/phone';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly blocklist: BlocklistService,
    private readonly billing: BillingService,
  ) {}

  async stats(now: Date = new Date()): Promise<string> {
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const [users, confirmed, blockedUsers, callsTotal, callsDay, byStatus, topups, refunds, blockedNumbers] =
      await Promise.all([
        this.prisma.user.count(),
        this.prisma.user.count({ where: { ageConfirmedAt: { not: null } } }),
        this.prisma.user.count({ where: { isBlocked: true } }),
        this.prisma.call.count(),
        this.prisma.call.count({ where: { createdAt: { gte: dayAgo } } }),
        this.prisma.call.groupBy({ by: ['status'], _count: { _all: true } }),
        this.prisma.payment.aggregate({ where: { status: PaymentStatus.SUCCESS }, _sum: { amount: true } }),
        this.prisma.transaction.aggregate({ where: { type: TransactionType.REFUND }, _sum: { amount: true } }),
        this.prisma.blockedNumber.groupBy({ by: ['reason'], _count: { _all: true } }),
      ]);

    const statusLine = Object.values(CallStatus)
      .map((s) => `${s}: ${byStatus.find((b) => b.status === s)?._count._all ?? 0}`)
      .join(', ');
    const blockedLine = blockedNumbers.map((b) => `${b.reason}: ${b._count._all}`).join(', ') || '0';

    return [
      '<b>📊 Статистика</b>',
      `Користувачі: ${users} (18+: ${confirmed}, заблоковано: ${blockedUsers})`,
      `Дзвінки: ${callsTotal} (за добу: ${callsDay})`,
      `Статуси: ${statusLine}`,
      `Поповнення: ${uah(topups._sum.amount ?? 0)}`,
      `Повернення: ${uah(refunds._sum.amount ?? 0)}`,
      `Заблоковані номери: ${blockedLine}`,
    ].join('\n');
  }

  private async resolveUser(ref: string) {
    if (/^\d+$/.test(ref)) return this.users.findByTelegramId(BigInt(ref));
    return this.users.findByUsername(ref);
  }

  async setUserBlocked(ref: string, blocked: boolean): Promise<string> {
    const user = await this.resolveUser(ref);
    if (!user) return 'Користувача не знайдено.';
    await this.users.setBlocked(user.id, blocked);
    return `Користувача ${user.telegramId} ${blocked ? 'заблоковано' : 'розблоковано'}.`;
  }

  async blockPhone(raw: string, comment?: string): Promise<string> {
    const phone = normalizeUaPhone(raw);
    if (!phone) return 'Некоректний номер.';
    await this.blocklist.blockByAdmin(phone, comment);
    return `Номер ${phone} заблоковано.`;
  }

  async unblockPhone(raw: string): Promise<string> {
    const phone = normalizeUaPhone(raw);
    if (!phone) return 'Некоректний номер.';
    const res = await this.blocklist.unblockByAdmin(phone);
    if (res === 'opt_out') return `Номер ${phone} відмовився від дзвінків (opt-out) — розблокувати неможливо.`;
    if (res === 'not_found') return `Номер ${phone} не заблоковано.`;
    return `Номер ${phone} розблоковано.`;
  }

  async adjustBalance(ref: string, amountUah: number, comment?: string): Promise<string> {
    const user = await this.resolveUser(ref);
    if (!user) return 'Користувача не знайдено.';
    if (!Number.isFinite(amountUah) || amountUah === 0) return 'Некоректна сума.';
    const kopecks = Math.round(amountUah * 100);
    await this.prisma.$transaction((tx) =>
      this.billing.credit(tx, user.id, kopecks, 'ADMIN_ADJUSTMENT', { comment: comment ?? 'admin' }),
    );
    return `Баланс ${user.telegramId} змінено на ${uah(kopecks)}.`;
  }
}
