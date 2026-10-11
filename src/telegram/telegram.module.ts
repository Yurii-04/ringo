import { Global, Module } from '@nestjs/common';
import { Bot } from 'grammy';
import { APP_CONFIG, AppConfig } from '../config/config';
import { NotificationService } from './notification.service';
import { TELEGRAM_BOT } from './tokens';

export { TELEGRAM_BOT } from './tokens';

/** Holds the grammY Bot instance; shared by the bot handlers and outgoing notifications. */
@Global()
@Module({
  providers: [
    { provide: TELEGRAM_BOT, inject: [APP_CONFIG], useFactory: (c: AppConfig) => new Bot(c.TELEGRAM_BOT_TOKEN) },
    NotificationService,
  ],
  exports: [TELEGRAM_BOT, NotificationService],
})
export class TelegramModule {}
