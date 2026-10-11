import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { CallsModule } from '../calls/calls.module';
import { ModerationModule } from '../moderation/moderation.module';
import { PaymentsModule } from '../payments/payments.module';
import { UsersModule } from '../users/users.module';
import { BotService } from './bot.service';
import { DraftStore } from './draft-store';

@Module({
  imports: [UsersModule, CallsModule, PaymentsModule, ModerationModule, AdminModule],
  providers: [BotService, DraftStore],
})
export class BotModule {}
