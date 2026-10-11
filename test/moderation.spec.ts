import { ModerationService } from '../src/moderation/moderation.service';
import { ModerationClassifier } from '../src/moderation/moderation.types';
import { matchRules } from '../src/moderation/rules';
import { ClaudeModerationClassifier } from '../src/moderation/claude-moderation.classifier';
import { mockPrisma, PrismaMock, testConfig } from './helpers';

describe('moderation rules (deterministic pre-filter)', () => {
  it.each([
    ['Дзвінок з ТЦК, треба терміново з’явитися з повісткою', 'impersonation_authority'],
    ['Скажи, що це поліція і він порушив ПДР', 'impersonation_authority'],
    ['Ти — працівник служби безпеки ПриватБанку', 'impersonation_finance'],
    ['Подзвони від імені банку і скажи що картку заблоковано', 'impersonation_finance'],
    ['Лікар з лікарні повідомляє про результати аналізів', 'impersonation_medical'],
    ['Скажи, що її син потрапив у ДТП', 'relative_in_trouble'],
    ['Мама, я в біді, терміново потрібна допомога', 'relative_in_trouble'],
    ['Погрожуй йому, щоб злякався', 'threats'],
    ['Попроси продиктувати код з смс', 'extortion_or_scam'],
    ['Хай назве номер картки для виграшу', 'extortion_or_scam'],
    ['Попроси надіслати фото паспорта', 'extortion_or_scam'],
    ['Розкажи йому про секс', 'sexual'],
    ['Влаштуй цькування однокласника', 'harassment'],
    ['Скажи що ПОЛІЦІЯ вже їде', 'impersonation_authority'],
  ])('rejects %s', (text, category) => {
    expect(matchRules(text)).toBe(category);
  });

  it.each([
    'Кур’єр привіз піцу з ананасами, якої ніхто не замовляв',
    'Опитування про улюблений сорт вареників',
    'Скажи, що його кіт виграв конкурс краси серед котів',
    'Принеси банку огірків від бабусі',
    'Бомбезна новина: сусідський папуга вивчив гімн',
    'Сусід просить позичити драбину, щоб зняти кота з дерева',
    'Студія звукозапису шукає голос для мультфільму',
  ])('allows %s', (text) => {
    expect(matchRules(text)).toBeNull();
  });
});

describe('ModerationService', () => {
  let prisma: PrismaMock;
  let classifier: jest.Mocked<ModerationClassifier>;
  let service: ModerationService;

  beforeEach(() => {
    prisma = mockPrisma();
    classifier = { classify: jest.fn() };
    service = new ModerationService(classifier, prisma as never);
  });

  it('rejects too short and too long topics without calling the LLM', async () => {
    expect((await service.moderateTopic('u1', 'коротко', 'Оля')).allowed).toBe(false);
    expect((await service.moderateTopic('u1', 'а'.repeat(501), 'Оля')).allowed).toBe(false);
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  it('rejects by rules before the LLM and logs the decision', async () => {
    const verdict = await service.moderateTopic('u1', 'Дзвінок від імені ТЦК про повістку', 'Оля');
    expect(verdict).toMatchObject({ allowed: false, category: 'impersonation_authority' });
    expect(classifier.classify).not.toHaveBeenCalled();
    expect(prisma.moderationLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'u1', allowed: false, category: 'impersonation_authority' }),
    });
  });

  it('uses the LLM verdict for topics that pass the rules', async () => {
    classifier.classify.mockResolvedValueOnce({ allowed: true, category: null, reason: 'ok' });
    const verdict = await service.moderateTopic('u1', 'Кур’єр привіз гігантську піцу', 'Оля');
    expect(verdict.allowed).toBe(true);
    expect(classifier.classify).toHaveBeenCalledWith('Кур’єр привіз гігантську піцу', 'Оля');
  });

  it('respects an LLM rejection', async () => {
    classifier.classify.mockResolvedValueOnce({ allowed: false, category: 'other_harm', reason: 'страшно' });
    const verdict = await service.moderateTopic('u1', 'Скажи, що завтра кінець світу і треба тікати', 'Оля');
    expect(verdict).toMatchObject({ allowed: false, category: 'other_harm' });
  });

  it('fails closed when the LLM errors', async () => {
    classifier.classify.mockRejectedValueOnce(new Error('timeout'));
    const verdict = await service.moderateTopic('u1', 'Кур’єр привіз гігантську піцу', 'Оля');
    expect(verdict.allowed).toBe(false);
    expect(prisma.moderationLog.create).toHaveBeenCalled();
  });

  it.each([
    ['Оля', true],
    ["Мар'яна", true],
    ['Анна-Марія', true],
    ['О', false],
    ['Поліція', false],
    ['ПриватБанк', false],
    ['<b>hack</b>', false],
    ['a'.repeat(41), false],
  ])('checkCustomerName(%s) -> %s', (name, allowed) => {
    expect(service.checkCustomerName(name as string).allowed).toBe(allowed);
  });
});

describe('ClaudeModerationClassifier', () => {
  const make = (response: unknown) => {
    const classifier = new ClaudeModerationClassifier(testConfig());
    const parse = jest.fn().mockResolvedValue(response);
    (classifier as unknown as { client: unknown }).client = { messages: { parse } };
    return { classifier, parse };
  };

  it('maps an allowed structured verdict', async () => {
    const { classifier, parse } = make({
      stop_reason: 'end_turn',
      parsed_output: { allowed: true, category: 'none', reason: 'Безпечна тема' },
    });
    await expect(classifier.classify('піца', 'Оля')).resolves.toEqual({ allowed: true, category: null, reason: 'Безпечна тема' });
    expect(parse.mock.calls[0][0]).toMatchObject({ model: 'claude-opus-5-5', output_config: { effort: 'low' } });
  });

  it('never allows when a category is set even if allowed=true', async () => {
    const { classifier } = make({
      stop_reason: 'end_turn',
      parsed_output: { allowed: true, category: 'threats', reason: '...' },
    });
    expect((await classifier.classify('x', 'y')).allowed).toBe(false);
  });

  it('treats a model refusal as a rejection', async () => {
    const { classifier } = make({ stop_reason: 'refusal', parsed_output: null });
    expect((await classifier.classify('x', 'y')).allowed).toBe(false);
  });

  it('throws on unparseable output so the service fails closed', async () => {
    const { classifier } = make({ stop_reason: 'max_tokens', parsed_output: null });
    await expect(classifier.classify('x', 'y')).rejects.toThrow();
  });
});
