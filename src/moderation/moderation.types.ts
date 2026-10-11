export const MODERATION_CATEGORIES = [
  'impersonation_authority', // держоргани, ТЦК, поліція, СБУ, суд, військові
  'impersonation_finance', // банки, платіжні сервіси
  'impersonation_medical', // лікарні, лікарі, медпрацівники
  'relative_in_trouble', // «родич у біді», ДТП, затримання
  'threats', // погрози, залякування
  'extortion_or_scam', // вимагання грошей, даних, документів, кодів
  'sexual', // сексуальний контент
  'harassment', // цькування, образи, дискримінація
  'other_harm',
] as const;

export type ModerationCategory = (typeof MODERATION_CATEGORIES)[number];

export interface ModerationVerdict {
  allowed: boolean;
  category: ModerationCategory | null;
  reason: string;
}

/** Pluggable LLM classifier so moderation logic can be unit-tested without network. */
export interface ModerationClassifier {
  classify(topic: string, customerName: string): Promise<ModerationVerdict>;
}

export const MODERATION_CLASSIFIER = Symbol('MODERATION_CLASSIFIER');
