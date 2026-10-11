import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Call, CallStatus, Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { BillingService } from '../billing/billing.service';
import { BlocklistService } from '../blocklist/blocklist.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from '../telegram/notification.service';
import { CallOutcome, CallResult, VoiceEvent } from '../voice/voice-provider.interface';
import { CALLS_QUEUE, CallJobData, JOB_DELIVER_RECORDING } from './calls.constants';
import { escapeHtml, formatCallReport, formatTranscript } from './call-report';

const OUTCOME_STATUS: Record<CallOutcome, CallStatus> = {
  completed: CallStatus.COMPLETED,
  no_answer: CallStatus.NO_ANSWER,
  voicemail: CallStatus.VOICEMAIL,
  failed: CallStatus.FAILED,
};

/** Outcomes the customer does not pay for. */
export const REFUNDABLE_OUTCOMES: ReadonlySet<CallOutcome> = new Set(['no_answer', 'voicemail', 'failed']);

const ACTIVE_STATUSES: CallStatus[] = [CallStatus.QUEUED, CallStatus.DIALING];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_INLINE_TRANSCRIPT = 3500;

/**
 * Applies provider results to calls: final status, refunds, opt-out blocking and
 * customer notifications. Every handler is idempotent (webhooks can be retried).
 */
@Injectable()
export class CallResultService {
  private readonly logger = new Logger(CallResultService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly blocklist: BlocklistService,
    private readonly notifications: NotificationService,
    @InjectQueue(CALLS_QUEUE) private readonly queue: Queue<CallJobData>,
  ) {}

  async handleEvent(event: VoiceEvent): Promise<void> {
    if (event.kind === 'result') return this.applyResult(event.result);
    if (event.kind === 'machine_detection') return this.applyMachineDetection(event);
  }

  async applyResult(result: CallResult): Promise<void> {
    const call = await this.findCall(result.callId, result.providerCallId);
    if (!call) {
      this.logger.warn(`Result for unknown call (callId=${result.callId}, provider=${result.providerCallId})`);
      return;
    }

    // AMD may have flagged the call as a machine before the transcript arrived.
    const outcome: CallOutcome = call.machineDetected && result.outcome === 'completed' ? 'voicemail' : result.outcome;
    const status = OUTCOME_STATUS[outcome];
    const optOut = outcome === 'completed' && result.optOut;

    const { count } = await this.prisma.call.updateMany({
      where: { id: call.id, status: { in: ACTIVE_STATUSES } },
      data: {
        status,
        providerCallId: call.providerCallId ?? (result.providerCallId || null),
        durationSec: result.durationSec,
        transcript: result.transcript as unknown as Prisma.InputJsonValue,
        summary: result.summary,
        terminationReason: result.terminationReason,
        optOut,
        finishedAt: new Date(),
      },
    });
    if (count === 0) {
      this.logger.debug(`Call ${call.id} already finalized, skipping duplicate result`);
      return;
    }

    const refunded = REFUNDABLE_OUTCOMES.has(outcome)
      ? await this.billing.refundCall(call.id, `outcome=${outcome}`)
      : false;
    if (optOut) await this.blocklist.blockOptOut(call.toNumber, `opt-out during call ${call.id}`);

    await this.notifyCustomer({ ...call, status, durationSec: result.durationSec, summary: result.summary ?? null, optOut }, refunded, result);

    if (status === CallStatus.COMPLETED) {
      await this.queue.add(
        JOB_DELIVER_RECORDING,
        { callId: call.id },
        { jobId: `rec-${call.id}`, delay: 20_000, attempts: 6, backoff: { type: 'exponential', delay: 20_000 } },
      );
    }
  }

  async applyMachineDetection(event: { providerCallId: string; callId?: string; isMachine: boolean }): Promise<void> {
    if (!event.isMachine) return;
    const call = await this.findCall(event.callId, event.providerCallId);
    if (!call) return;
    await this.prisma.call.update({ where: { id: call.id }, data: { machineDetected: true } });

    // Late AMD verdict for a call already reported as answered: correct it and refund.
    if (call.status === CallStatus.COMPLETED) {
      const { count } = await this.prisma.call.updateMany({
        where: { id: call.id, status: CallStatus.COMPLETED },
        data: { status: CallStatus.VOICEMAIL, optOut: false },
      });
      if (count > 0 && (await this.billing.refundCall(call.id, 'late AMD verdict: machine'))) {
        const user = await this.prisma.user.findUniqueOrThrow({ where: { id: call.userId } });
        await this.notifications.sendText(
          user.telegramId,
          '📼 Уточнення: попередній дзвінок потрапив на автовідповідач. Кошти повернуто на баланс.',
        );
      }
    }
  }

  /**
   * Marks a call that never reached the provider as failed and refunds it.
   * No-op once the provider accepted the call (providerCallId is set).
   */
  async failBeforeDial(callId: string, reason: string, statuses: CallStatus[] = ACTIVE_STATUSES): Promise<void> {
    const { count } = await this.prisma.call.updateMany({
      where: { id: callId, status: { in: statuses }, providerCallId: null },
      data: { status: CallStatus.FAILED, terminationReason: reason.slice(0, 500), finishedAt: new Date() },
    });
    if (count === 0) return;
    const refunded = await this.billing.refundCall(callId, reason.slice(0, 200));
    const call = await this.prisma.call.findUniqueOrThrow({ where: { id: callId } });
    await this.notifyCustomer(call, refunded);
  }

  private async findCall(callId: string | undefined, providerCallId: string): Promise<Call | null> {
    if (callId && UUID_RE.test(callId)) {
      const byId = await this.prisma.call.findUnique({ where: { id: callId } });
      if (byId) return byId;
    }
    if (!providerCallId) return null;
    return this.prisma.call.findUnique({ where: { providerCallId } });
  }

  private async notifyCustomer(call: Call, refunded: boolean, result?: CallResult): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: call.userId } });
    await this.notifications.sendText(
      user.telegramId,
      formatCallReport({
        status: call.status,
        toNumber: call.toNumber,
        durationSec: call.durationSec,
        summary: call.summary,
        refunded,
        price: call.price,
        optOut: call.optOut,
      }),
    );

    if (call.status !== CallStatus.COMPLETED || !result?.transcript.length) return;
    const transcript = formatTranscript(result.transcript);
    if (transcript.length <= MAX_INLINE_TRANSCRIPT) {
      await this.notifications.sendText(user.telegramId, `<b>📝 Транскрипт</b>\n\n${escapeHtml(transcript)}`);
    } else {
      await this.notifications.sendDocument(user.telegramId, Buffer.from(transcript, 'utf8'), `transcript-${call.id}.txt`, '📝 Транскрипт');
    }
    await this.notifications.sendText(user.telegramId, '🎧 Запис дзвінка надішлю, щойно він буде готовий.');
  }
}
