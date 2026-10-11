import { normalizeForRules } from '../moderation/rules';

/**
 * Fallback detection of "don't call me again" phrases in the callee's speech,
 * used in addition to the agent's own `opt_out` data-collection field.
 */
const OPT_OUT_PATTERNS = [
  /(?:не|більше не|больше не)\s+(?:дзвоніть|дзвони|телефонуйте|телефонуй|звоніть|звоните|звони|набирайте|турбуйте)/u,
  /(?:видаліть|вилучіть|удалите|приберіть)\s+(?:мій|мой)\s+номер/u,
  /(?:забудьте|забудь)\s+(?:мій|мой|цей|этот)\s+номер/u,
  /(?:внесіть|додайте|внесите|добавьте).{0,20}(?:чорн|черн|блок|стоп)/u,
  /\b(?:do not|don't|stop)\s+call(?:ing)?\s+me\b/u,
];

export function detectOptOut(userUtterances: string[]): boolean {
  return userUtterances.some((u) => {
    const text = normalizeForRules(u);
    return OPT_OUT_PATTERNS.some((p) => p.test(text));
  });
}
