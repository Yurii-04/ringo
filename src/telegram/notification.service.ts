import { Inject, Injectable, Logger } from '@nestjs/common';
import { Bot, InputFile } from 'grammy';
import { TELEGRAM_BOT } from './tokens';

/** Outgoing messages to users. Failures are logged, never thrown into business flows. */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(@Inject(TELEGRAM_BOT) private readonly bot: Bot) {}

  async sendText(telegramId: bigint, text: string): Promise<void> {
    try {
      await this.bot.api.sendMessage(telegramId.toString(), text, { parse_mode: 'HTML' });
    } catch (err) {
      this.logger.warn(`sendMessage to ${telegramId} failed: ${(err as Error).message}`);
    }
  }

  async sendDocument(telegramId: bigint, content: Buffer, filename: string, caption?: string): Promise<void> {
    try {
      await this.bot.api.sendDocument(telegramId.toString(), new InputFile(content, filename), { caption });
    } catch (err) {
      this.logger.warn(`sendDocument to ${telegramId} failed: ${(err as Error).message}`);
    }
  }

  /** Throws on failure so the caller (a retrying job) can retry. */
  async sendAudio(telegramId: bigint, audio: Buffer, filename: string, caption?: string): Promise<void> {
    await this.bot.api.sendAudio(telegramId.toString(), new InputFile(audio, filename), { caption, title: 'Запис розіграшу' });
  }
}
