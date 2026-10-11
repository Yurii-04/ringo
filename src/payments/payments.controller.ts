import { Body, Controller, ForbiddenException, HttpCode, Post } from '@nestjs/common';
import { PaymentsService } from './payments.service';

@Controller('payments/liqpay')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /** LiqPay server_url callback: application/x-www-form-urlencoded { data, signature }. */
  @Post('callback')
  @HttpCode(200)
  async callback(@Body() body: { data?: string; signature?: string }): Promise<{ ok: true }> {
    const ok = await this.payments.handleCallback(body?.data ?? '', body?.signature ?? '');
    if (!ok) throw new ForbiddenException('Invalid signature');
    return { ok: true };
  }
}
