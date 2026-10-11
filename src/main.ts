import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { APP_CONFIG, AppConfig } from './config/config';

async function bootstrap() {
  // rawBody is required to verify ElevenLabs webhook signatures.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  // post_call_audio webhooks carry base64 audio; accept them (and ignore) instead of failing with 413.
  app.useBodyParser('json', { limit: '25mb' });
  app.useBodyParser('urlencoded', { extended: false, limit: '1mb' });
  app.enableShutdownHooks();
  const config = app.get<AppConfig>(APP_CONFIG);
  await app.listen(config.PORT);
  Logger.log(`HTTP server listening on :${config.PORT}`, 'Bootstrap');
}

void bootstrap();
