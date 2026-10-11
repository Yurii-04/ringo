import { Module } from '@nestjs/common';
import { CallLimitsService } from './call-limits.service';

@Module({ providers: [CallLimitsService], exports: [CallLimitsService] })
export class LimitsModule {}
