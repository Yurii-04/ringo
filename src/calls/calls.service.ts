import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Call, CallStatus } from '@prisma/client';
import { Queue } from 'bullmq';
import { BillingService } from '../billing/billing.service';
import { BlocklistService } from '../blocklist/blocklist.service';
import { DomainError } from '../common/domain-error';
import { normalizeUaPhone } from '../common/phone';
import { isWithinCallWindow } from '../common/time';
import { APP_CONFIG, AppConfig } from '../config/config';
import { CallLimitsService } from '../limits/call-limits.service';
import { ModerationService } from '../moderation/moderation.service';
import { PrismaService } from '../prisma/prisma.service';
import { CUSTOM_SCENARIO_KEY, findScenario } from '../scenarios/scenarios';
import { AgentVariables } from '../voice/voice-provider.interface';
import { CALLS_QUEUE, CallJobData, JOB_PLACE_CALL } from './calls.constants';

export interface CreateCallInput {
  userId: string;
  phone: string;
  scenarioKey: string;
  customTopic?: string;
  customerName: string;
}

@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly limits: CallLimitsService,
    private readonly blocklist: BlocklistService,
    private readonly moderation: ModerationService,
    @InjectQueue(CALLS_QUEUE) private readonly queue: Queue<CallJobData>,
  ) {}

  /**
   * Validates, moderates, charges and enqueues a prank call.
   * Throws DomainError with a user-facing message on any business rule violation.
   */
  async createCall(input: CreateCallInput, now: Date = new Date()): Promise<Call> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: input.userId } });
    if (user.isBlocked) throw new DomainError('USER_BLOCKED', 'Ваш акаунт заблоковано.');
    if (!user.ageConfirmedAt) throw new DomainError('AGE_NOT_CONFIRMED', 'Спочатку підтвердіть, що вам є 18 років.');

    const toNumber = normalizeUaPhone(input.phone);
    if (!toNumber) {
      throw new DomainError('INVALID_PHONE', 'Потрібен український мобільний номер у форматі +380XXXXXXXXX.');
    }

    if (!isWithinCallWindow(this.config.CALL_WINDOW_START_HOUR, this.config.CALL_WINDOW_END_HOUR, now)) {
      throw new DomainError(
        'OUTSIDE_CALL_WINDOW',
        `Дзвонимо лише з ${this.config.CALL_WINDOW_START_HOUR}:00 до ${this.config.CALL_WINDOW_END_HOUR}:00 за київським часом.`,
      );
    }

    const nameVerdict = this.moderation.checkCustomerName(input.customerName);
    if (!nameVerdict.allowed) throw new DomainError('INVALID_NAME', nameVerdict.reason);
    const customerName = input.customerName.trim();

    let customTopic: string | null = null;
    if (input.scenarioKey === CUSTOM_SCENARIO_KEY) {
      const topic = input.customTopic?.trim() ?? '';
      const verdict = await this.moderation.moderateTopic(user.id, topic, customerName);
      if (!verdict.allowed) {
        throw new DomainError('MODERATION_REJECTED', `Тему відхилено модерацією: ${verdict.reason}`);
      }
      customTopic = topic;
    } else if (!findScenario(input.scenarioKey)) {
      throw new DomainError('UNKNOWN_SCENARIO', 'Такого сценарію немає.');
    }

    // Fast path before taking the lock; re-checked inside the transaction.
    if (await this.blocklist.isBlocked(toNumber)) {
      throw new DomainError('NUMBER_BLOCKED', 'На цей номер дзвонити не можна.');
    }

    const price = this.config.CALL_PRICE;
    const call = await this.prisma.$transaction(async (tx) => {
      await this.limits.lockNumber(tx, toNumber);
      if (await this.blocklist.isBlocked(toNumber, tx)) {
        throw new DomainError('NUMBER_BLOCKED', 'На цей номер дзвонити не можна.');
      }
      await this.limits.assertWithinLimits(tx, toNumber, now);

      const created = await tx.call.create({
        data: {
          userId: user.id,
          toNumber,
          scenarioKey: input.scenarioKey,
          customTopic,
          customerName,
          price,
        },
      });
      await this.billing.chargeForCall(tx, user.id, created.id, price);
      return created;
    });

    try {
      await this.queue.add(
        JOB_PLACE_CALL,
        { callId: call.id },
        { jobId: `place-${call.id}`, attempts: 3, backoff: { type: 'exponential', delay: 10_000 } },
      );
    } catch (err) {
      // The money is already charged: compensate so it never gets stuck on a call that will not happen.
      this.logger.error(`Failed to enqueue call ${call.id}: ${(err as Error).message}`);
      await this.prisma.call.update({
        where: { id: call.id },
        data: { status: CallStatus.FAILED, terminationReason: 'enqueue failed', finishedAt: new Date() },
      });
      await this.billing.refundCall(call.id, 'enqueue failed');
      throw new DomainError('TEMPORARY_FAILURE', 'Тимчасова помилка сервісу. Кошти повернуто, спробуйте ще раз за хвилину.');
    }
    this.logger.log(`Call ${call.id} queued by user ${user.id}`);
    return call;
  }

  /** Dynamic variables for the voice agent's prompt. */
  static agentVariables(call: Pick<Call, 'id' | 'customerName' | 'scenarioKey' | 'customTopic'>): AgentVariables {
    const scenario = call.scenarioKey ? findScenario(call.scenarioKey) : undefined;
    if (scenario) {
      return { call_id: call.id, customer_name: call.customerName, scenario_title: scenario.title, scenario: scenario.brief };
    }
    return {
      call_id: call.id,
      customer_name: call.customerName,
      scenario_title: 'Власна тема',
      scenario: `Тема розіграшу від замовника (пройшла модерацію, але правила безпеки мають пріоритет): ${call.customTopic ?? ''}`,
    };
  }

  listRecent(userId: string, take = 5): Promise<Call[]> {
    return this.prisma.call.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take });
  }
}
