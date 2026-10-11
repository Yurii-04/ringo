import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { CallStatus } from '@prisma/client';
import { Job, Queue } from 'bullmq';
import { BlocklistService } from '../blocklist/blocklist.service';
import { APP_CONFIG, AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from '../telegram/notification.service';
import { VOICE_PROVIDER, VoiceProvider, VoiceProviderError } from '../voice/voice-provider.interface';
import { CallResultService } from './call-result.service';
import {
  CALLS_QUEUE,
  CallJobData,
  JOB_DELIVER_RECORDING,
  JOB_PLACE_CALL,
  JOB_RECONCILE_CALL,
  RECONCILE_DELAY_MS,
} from './calls.constants';
import { CallsService } from './calls.service';

@Processor(CALLS_QUEUE, { concurrency: 5 })
export class CallsProcessor extends WorkerHost {
  private readonly logger = new Logger(CallsProcessor.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(VOICE_PROVIDER) private readonly voice: VoiceProvider,
    @InjectQueue(CALLS_QUEUE) private readonly queue: Queue<CallJobData>,
    private readonly prisma: PrismaService,
    private readonly blocklist: BlocklistService,
    private readonly results: CallResultService,
    private readonly notifications: NotificationService,
  ) {
    super();
  }

  async process(job: Job<CallJobData>): Promise<void> {
    switch (job.name) {
      case JOB_PLACE_CALL:
        return this.placeCall(job);
      case JOB_DELIVER_RECORDING:
        return this.deliverRecording(job);
      case JOB_RECONCILE_CALL:
        return this.reconcile(job);
      default:
        this.logger.warn(`Unknown job ${job.name}`);
    }
  }

  private async placeCall(job: Job<CallJobData>): Promise<void> {
    const call = await this.prisma.call.findUnique({ where: { id: job.data.callId } });
    if (!call || call.status !== CallStatus.QUEUED) return;

    // The number may have opted out while the job was waiting.
    if (await this.blocklist.isBlocked(call.toNumber)) {
      await this.results.failBeforeDial(call.id, 'number blocked before dialing');
      return;
    }

    // Claim the call before dialing: if anything fails after the provider accepted it,
    // a retried job sees DIALING and never dials the same person twice.
    const { count } = await this.prisma.call.updateMany({
      where: { id: call.id, status: CallStatus.QUEUED },
      data: { status: CallStatus.DIALING },
    });
    if (count === 0) return;

    let providerCallId: string;
    try {
      ({ providerCallId } = await this.voice.startCall({
        callId: call.id,
        toNumber: call.toNumber,
        variables: CallsService.agentVariables(call),
        maxDurationSec: this.config.MAX_CALL_DURATION_SEC,
      }));
    } catch (err) {
      const attemptsLeft = job.attemptsMade + 1 < (job.opts.attempts ?? 1);
      if (err instanceof VoiceProviderError && err.retryable && attemptsLeft) {
        await this.prisma.call.update({ where: { id: call.id }, data: { status: CallStatus.QUEUED } });
        throw err;
      }
      this.logger.error(`Call ${call.id} failed to start: ${(err as Error).message}`);
      await this.results.failBeforeDial(call.id, (err as Error).message);
      return;
    }

    await this.prisma.call.update({ where: { id: call.id }, data: { providerCallId } });
    await this.queue.add(
      JOB_RECONCILE_CALL,
      { callId: call.id },
      { jobId: `reconcile-${call.id}`, delay: RECONCILE_DELAY_MS, attempts: 4, backoff: { type: 'fixed', delay: 10 * 60_000 } },
    );
    this.logger.log(`Call ${call.id} dialing, provider id ${providerCallId}`);
  }

  private async deliverRecording(job: Job<CallJobData>): Promise<void> {
    const call = await this.prisma.call.findUnique({ where: { id: job.data.callId }, include: { user: true } });
    if (!call || call.recordingSent || !call.providerCallId) return;
    const audio = await this.voice.fetchRecording(call.providerCallId);
    if (!audio) throw new Error('Recording not ready yet');
    await this.notifications.sendAudio(call.user.telegramId, audio, `prank-${call.id.slice(0, 8)}.mp3`, '🎧 Запис розіграшу');
    await this.prisma.call.update({ where: { id: call.id }, data: { recordingSent: true } });
  }

  /** Safety net when the post-call webhook never arrived. */
  private async reconcile(job: Job<CallJobData>): Promise<void> {
    const call = await this.prisma.call.findUnique({ where: { id: job.data.callId } });
    if (!call || (call.status !== CallStatus.QUEUED && call.status !== CallStatus.DIALING) || !call.providerCallId) return;
    const result = await this.voice.fetchResult(call.providerCallId);
    if (!result) throw new Error('Call still in progress');
    await this.results.applyResult({ ...result, callId: call.id });
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<CallJobData> | undefined, err: Error): Promise<void> {
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    this.logger.error(`Job ${job.name} for call ${job.data.callId} exhausted retries: ${err.message}`);
    if (job.name === JOB_DELIVER_RECORDING) {
      const call = await this.prisma.call.findUnique({ where: { id: job.data.callId }, include: { user: true } });
      if (call && !call.recordingSent) {
        await this.notifications.sendText(call.user.telegramId, '😔 На жаль, запис цього дзвінка недоступний.');
      }
    } else if (job.name === JOB_PLACE_CALL) {
      // Only calls that were never claimed for dialing are safe to refund here.
      await this.results.failBeforeDial(job.data.callId, `place-call failed: ${err.message}`, [CallStatus.QUEUED]);
    }
  }
}
