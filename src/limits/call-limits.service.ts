import { Inject, Injectable } from '@nestjs/common';
import { CallStatus } from '@prisma/client';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DomainError } from '../common/domain-error';
import { Tx } from '../prisma/types';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Per-recipient rate limits (rolling windows): N calls per 24h and M per 7 days.
 * Every call that could have rung the phone counts, including unanswered ones;
 * only calls that failed before dialing (FAILED) are excluded.
 */
@Injectable()
export class CallLimitsService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /**
   * Serializes call creation per phone number for the rest of the transaction,
   * so two concurrent orders cannot both pass the limit check.
   */
  async lockNumber(tx: Tx, phone: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${phone}))`;
  }

  async assertWithinLimits(tx: Tx, phone: string, now: Date = new Date()): Promise<void> {
    const countSince = (since: Date) =>
      tx.call.count({
        where: { toNumber: phone, createdAt: { gte: since }, status: { not: CallStatus.FAILED } },
      });

    const [day, week] = await Promise.all([
      countSince(new Date(now.getTime() - DAY_MS)),
      countSince(new Date(now.getTime() - 7 * DAY_MS)),
    ]);

    if (day >= this.config.CALLS_PER_NUMBER_PER_DAY) {
      throw new DomainError(
        'DAILY_LIMIT',
        `На цей номер вже дзвонили протягом останньої доби. Ліміт — ${this.config.CALLS_PER_NUMBER_PER_DAY} дзвінок на добу.`,
      );
    }
    if (week >= this.config.CALLS_PER_NUMBER_PER_WEEK) {
      throw new DomainError(
        'WEEKLY_LIMIT',
        `Ліміт для цього номера — ${this.config.CALLS_PER_NUMBER_PER_WEEK} дзвінки на тиждень. Спробуйте пізніше.`,
      );
    }
  }
}
