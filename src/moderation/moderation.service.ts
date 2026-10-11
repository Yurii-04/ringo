import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { matchRules } from './rules';
import { MODERATION_CLASSIFIER, ModerationClassifier, ModerationVerdict } from './moderation.types';

export const TOPIC_MIN_LENGTH = 10;
export const TOPIC_MAX_LENGTH = 500;
export const NAME_MAX_LENGTH = 40;

const NAME_RE = /^[\p{L}][\p{L}'’ʼ\- ]*$/u;

@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);

  constructor(
    @Inject(MODERATION_CLASSIFIER) private readonly classifier: ModerationClassifier,
    private readonly prisma: PrismaService,
  ) {}

  /** Validates the customer name that the agent will say aloud. Cheap, no LLM. */
  checkCustomerName(name: string): ModerationVerdict {
    const trimmed = name.trim();
    if (trimmed.length < 2 || trimmed.length > NAME_MAX_LENGTH || !NAME_RE.test(trimmed)) {
      return {
        allowed: false,
        category: null,
        reason: `Ім'я має містити лише літери (2–${NAME_MAX_LENGTH} символів).`,
      };
    }
    const category = matchRules(trimmed);
    if (category) {
      return { allowed: false, category, reason: 'Таке ім’я використовувати не можна.' };
    }
    return { allowed: true, category: null, reason: '' };
  }

  /**
   * Moderates a free-form prank topic. Order: length -> deterministic rules -> LLM.
   * Fails closed: if the LLM is unavailable the topic is rejected.
   */
  async moderateTopic(userId: string, topic: string, customerName: string): Promise<ModerationVerdict> {
    const text = topic.trim();
    let verdict: ModerationVerdict;

    if (text.length < TOPIC_MIN_LENGTH || text.length > TOPIC_MAX_LENGTH) {
      verdict = {
        allowed: false,
        category: null,
        reason: `Опишіть тему в ${TOPIC_MIN_LENGTH}–${TOPIC_MAX_LENGTH} символах.`,
      };
    } else {
      const ruleCategory = matchRules(text);
      if (ruleCategory) {
        verdict = { allowed: false, category: ruleCategory, reason: 'Тема містить заборонений зміст.' };
      } else {
        try {
          verdict = await this.classifier.classify(text, customerName.trim());
        } catch (err) {
          this.logger.error(`LLM moderation failed: ${(err as Error).message}`);
          verdict = {
            allowed: false,
            category: null,
            reason: 'Не вдалося перевірити тему. Спробуйте пізніше або оберіть готовий сценарій.',
          };
        }
      }
    }

    await this.prisma.moderationLog.create({
      data: {
        userId,
        text,
        allowed: verdict.allowed,
        category: verdict.category,
        reason: verdict.reason,
      },
    });
    return verdict;
  }
}
