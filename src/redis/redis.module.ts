import { Global, Inject, Module, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG, AppConfig } from '../config/config';

export const REDIS = Symbol('REDIS');

@Global()
@Module({
  providers: [{ provide: REDIS, inject: [APP_CONFIG], useFactory: (c: AppConfig) => new Redis(c.REDIS_URL) }],
  exports: [REDIS],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onModuleDestroy() {
    await this.redis.quit();
  }
}
