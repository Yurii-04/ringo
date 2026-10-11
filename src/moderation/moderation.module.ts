import { Module } from '@nestjs/common';
import { ClaudeModerationClassifier } from './claude-moderation.classifier';
import { MODERATION_CLASSIFIER } from './moderation.types';
import { ModerationService } from './moderation.service';

@Module({
  providers: [ModerationService, { provide: MODERATION_CLASSIFIER, useClass: ClaudeModerationClassifier }],
  exports: [ModerationService],
})
export class ModerationModule {}
