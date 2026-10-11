import {
  Controller,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Post,
  RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { APP_CONFIG, AppConfig } from '../../config/config';
import { CallResultService } from '../../calls/call-result.service';
import { parseElevenLabsWebhook } from './elevenlabs.parser';
import { ELEVENLABS_SIGNATURE_HEADER, verifyElevenLabsSignature } from './elevenlabs.signature';

@Controller('webhooks/elevenlabs')
export class ElevenLabsWebhookController {
  private readonly logger = new Logger(ElevenLabsWebhookController.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly callResults: CallResultService,
  ) {}

  @Post()
  @HttpCode(200)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers(ELEVENLABS_SIGNATURE_HEADER) signature: string | undefined,
  ): Promise<{ ok: true }> {
    if (!req.rawBody || !verifyElevenLabsSignature(req.rawBody, signature, this.config.ELEVENLABS_WEBHOOK_SECRET)) {
      throw new UnauthorizedException('Invalid signature');
    }
    const event = parseElevenLabsWebhook(JSON.parse(req.rawBody.toString('utf8')));
    if (event.kind === 'ignored') {
      this.logger.debug(`Ignored ElevenLabs webhook: ${event.reason}`);
    } else {
      await this.callResults.handleEvent(event);
    }
    return { ok: true };
  }
}
