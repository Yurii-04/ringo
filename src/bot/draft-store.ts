import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';

export type DraftStep = 'phone' | 'scenario' | 'topic' | 'name' | 'confirm';

/** In-progress call order of a Telegram user. */
export interface CallDraft {
  step: DraftStep;
  phone?: string;
  scenarioKey?: string;
  customTopic?: string;
  customerName?: string;
}

const TTL_SEC = 60 * 60;

@Injectable()
export class DraftStore {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private key(telegramId: number): string {
    return `bot:draft:${telegramId}`;
  }

  async get(telegramId: number): Promise<CallDraft | null> {
    const raw = await this.redis.get(this.key(telegramId));
    return raw ? (JSON.parse(raw) as CallDraft) : null;
  }

  async set(telegramId: number, draft: CallDraft): Promise<void> {
    await this.redis.set(this.key(telegramId), JSON.stringify(draft), 'EX', TTL_SEC);
  }

  /** Atomically reads and deletes the draft — protects against double-tapping "Call". */
  async take(telegramId: number): Promise<CallDraft | null> {
    const raw = await this.redis.getdel(this.key(telegramId));
    return raw ? (JSON.parse(raw) as CallDraft) : null;
  }

  async clear(telegramId: number): Promise<void> {
    await this.redis.del(this.key(telegramId));
  }
}
