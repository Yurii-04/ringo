import { ModerationCategory } from './moderation.types';

/**
 * Fast deterministic pre-filter. It is intentionally strict: anything that
 * matches is rejected without calling the LLM, which handles the subtle cases.
 *
 * Each pattern is a regex source that must start at a word boundary.
 * A trailing `$` means the match must also end at a word boundary (whole word).
 * JS `\b` does not understand Cyrillic, hence the explicit \p{L} lookarounds.
 */
const RULES: Array<{ category: ModerationCategory; patterns: string[] }> = [
  {
    category: 'impersonation_authority',
    patterns: [
      'тцк$', 'військкомат', 'военкомат', 'повістк', 'повестк', 'мобілізац', 'мобилизац', 'поліц', 'полиц',
      'сбу$', 'дбр$', 'набу$', 'прокур', 'суд(?:у|і|ом|дя|ді|ов\\p{L}*)?$', 'податков', 'налогов', 'митниц',
      'таможн', 'пенсійн\\p{L}* фонд', 'дмс$', 'міграційн', 'міністерств', 'министерств', 'уряд', 'депутат',
      'президент', 'слідч', 'следовател', 'військов', 'военн', 'зсу$', 'police', 'fbi$', 'генштаб',
    ],
  },
  {
    category: 'impersonation_finance',
    patterns: [
      'банк(?:ом|ів|ір\\p{L}*|івськ\\p{L}*|овск\\p{L}*)?$', '(?:імені|із|зі) банку$', 'дзвон\\p{L}* з банку',
      'картк\\p{L}* (?:заблок|блок)', 'карт\\p{L}* заблок', 'приватбанк', 'монобанк', 'моно$', 'ощадбанк',
      'райффайзен', 'служб\\p{L}* безпеки', 'служб\\p{L}* безопасности', 'bank',
    ],
  },
  {
    category: 'impersonation_medical',
    patterns: [
      'лікар', 'больниц', 'врач', 'медсестр', 'медпрацівник', 'медработник', 'швидк\\p{L}* допомог',
      'скор\\p{L}* помощ', 'поліклінік', 'амбулатор', 'аналіз\\p{L}* крові', 'діагноз', 'диагноз', 'hospital',
      'doctor',
    ],
  },
  {
    category: 'relative_in_trouble',
    patterns: [
      'родич\\p{L}* (?:у|в) біді', 'родственник\\p{L}* в беде', '(?:у|в) біді$', 'в беде$', 'дтп$', 'аварі',
      'авари', 'затриман', 'задержан', 'викрал', 'викраден', 'похитил', 'похищен', 'заручник', 'заложник',
      'у відділку', 'в отделении',
    ],
  },
  {
    category: 'threats',
    patterns: [
      'погрож', 'угрож', 'вб(?:ю|ити|\'ю)$', 'уб(?:ью|ить)$', 'залякув', 'запугив', 'бомб(?!езн)', 'замінован',
      'мінуван', 'вибухівк', 'шантаж',
    ],
  },
  {
    category: 'extortion_or_scam',
    patterns: [
      'переказ\\p{L}* (?:гроші|кошти)', 'перевед\\p{L}* деньг', 'скин\\p{L}* (?:гроші|деньги|на карт)',
      'номер\\p{L}* карт', 'cvv$', 'cvc$', 'пін-?код', 'пин-?код', 'код\\p{L}* (?:з|із|из) смс', 'sms-?код',
      'смс-?код', 'пароль', 'паспорт', 'рнокпп$', 'інн$', 'инн$', 'ідентифікаційн', 'вимага', 'вымога', 'викуп',
      'выкуп', 'борг$', 'долг$', 'колектор', 'коллектор', 'кредит', 'передоплат', 'предоплат',
    ],
  },
  {
    category: 'sexual',
    patterns: ['секс', 'sex', 'інтим', 'интим', 'порн', 'porn', 'еротич', 'эротич', 'оголен', 'обнаж', 'нюд'],
  },
  {
    category: 'harassment',
    patterns: ['цькув', 'булінг', 'буллинг', 'травля$', 'принизи', 'униз(?:ить|ь)$', 'образи\\p{L}* (?:його|її)'],
  },
];

const COMPILED = RULES.map(({ category, patterns }) => ({
  category,
  regexes: patterns.map((p) => {
    const whole = p.endsWith('$');
    const body = whole ? p.slice(0, -1) : p;
    return new RegExp(`(?<![\\p{L}\\p{N}])${body}${whole ? '(?![\\p{L}\\p{N}])' : ''}`, 'u');
  }),
}));

export function normalizeForRules(text: string): string {
  return text.toLowerCase().replace(/ё/g, 'е').replace(/[’`ʼ]/g, "'").replace(/\s+/g, ' ');
}

export function matchRules(text: string): ModerationCategory | null {
  const normalized = normalizeForRules(text);
  for (const rule of COMPILED) {
    if (rule.regexes.some((r) => r.test(normalized))) return rule.category;
  }
  return null;
}
