import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { BotModule } from './bot/bot.module';
import { CallsModule } from './calls/calls.module';
import { APP_CONFIG, AppConfig } from './config/config';
import { ConfigModule } from './config/config.module';
import { HealthController } from './health/health.controller';
import { PaymentsModule } from './payments/payments.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { TelegramModule } from './telegram/telegram.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    RedisModule,
    TelegramModule,
    BullModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) => {
        const url = new URL(c.REDIS_URL);
        return {
          connection: {
            host: url.hostname,
            port: Number(url.port || 6379),
            username: url.username || undefined,
            password: url.password || undefined,
            db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : undefined,
            tls: url.protocol === 'rediss:' ? {} : undefined,
          },
        };
      },
    }),
    CallsModule,
    PaymentsModule,
    BotModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
