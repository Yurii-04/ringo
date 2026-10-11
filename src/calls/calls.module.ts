import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { BlocklistModule } from '../blocklist/blocklist.module';
import { LimitsModule } from '../limits/limits.module';
import { ModerationModule } from '../moderation/moderation.module';
import { ElevenLabsWebhookController } from '../voice/elevenlabs/elevenlabs-webhook.controller';
import { ElevenLabsVoiceProvider } from '../voice/elevenlabs/elevenlabs.provider';
import { VOICE_PROVIDER } from '../voice/voice-provider.interface';
import { CallResultService } from './call-result.service';
import { CALLS_QUEUE } from './calls.constants';
import { CallsProcessor } from './calls.processor';
import { CallsService } from './calls.service';

@Module({
  imports: [
    BullModule.registerQueue({
      name: CALLS_QUEUE,
      defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 5000 },
    }),
    BillingModule,
    BlocklistModule,
    LimitsModule,
    ModerationModule,
  ],
  providers: [
    CallsService,
    CallResultService,
    CallsProcessor,
    // Swap this binding to change the voice vendor (e.g. a SIP-trunk adapter).
    { provide: VOICE_PROVIDER, useClass: ElevenLabsVoiceProvider },
  ],
  controllers: [ElevenLabsWebhookController],
  exports: [CallsService],
})
export class CallsModule {}
