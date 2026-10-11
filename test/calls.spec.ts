import { DomainError } from '../src/common/domain-error';
import { maskPhone, normalizeUaPhone } from '../src/common/phone';
import { JOB_PLACE_CALL } from '../src/calls/calls.constants';
import { CallsService } from '../src/calls/calls.service';
import { mockPrisma, PrismaMock, testConfig } from './helpers';

describe('normalizeUaPhone', () => {
  it.each([
    ['+380671234567', '+380671234567'],
    ['380671234567', '+380671234567'],
    ['0671234567', '+380671234567'],
    ['+38 (067) 123-45-67', '+380671234567'],
    ['067 123 45 67', '+380671234567'],
    ['80931234567', '+380931234567'],
  ])('%s -> %s', (input, expected) => expect(normalizeUaPhone(input)).toBe(expected));

  it.each(['+48123456789', '+38044123456', '+3804412345678', '112', '+380 67 123 45 6', 'abc', '+380671234567; drop', ''])(
    'rejects %p',
    (input) => expect(normalizeUaPhone(input)).toBeNull(),
  );

  it('masks numbers for messages', () => expect(maskPhone('+380671234567')).toBe('+380 67 ***-**-67'));
});

describe('CallsService.createCall', () => {
  // 12:00 Kyiv time
  const NOW = new Date('2026-10-11T09:00:00Z');
  let prisma: PrismaMock;
  let billing: { chargeForCall: jest.Mock; refundCall: jest.Mock };
  let limits: { lockNumber: jest.Mock; assertWithinLimits: jest.Mock };
  let blocklist: { isBlocked: jest.Mock };
  let moderation: { checkCustomerName: jest.Mock; moderateTopic: jest.Mock };
  let queue: { add: jest.Mock };
  let service: CallsService;

  const input = { userId: 'u1', phone: '0671234567', scenarioKey: 'pizza', customerName: 'Оля' };

  beforeEach(() => {
    prisma = mockPrisma();
    billing = { chargeForCall: jest.fn(), refundCall: jest.fn() };
    limits = { lockNumber: jest.fn(), assertWithinLimits: jest.fn() };
    blocklist = { isBlocked: jest.fn().mockResolvedValue(false) };
    moderation = {
      checkCustomerName: jest.fn().mockReturnValue({ allowed: true, category: null, reason: '' }),
      moderateTopic: jest.fn().mockResolvedValue({ allowed: true, category: null, reason: '' }),
    };
    queue = { add: jest.fn() };
    service = new CallsService(
      testConfig(),
      prisma as never,
      billing as never,
      limits as never,
      blocklist as never,
      moderation as never,
      queue as never,
    );
    prisma.user.findUniqueOrThrow.mockResolvedValue({ id: 'u1', isBlocked: false, ageConfirmedAt: new Date() });
    prisma.call.create.mockImplementation(async ({ data }) => ({ id: 'c1', ...data }));
  });

  const expectError = async (code: string, override: Partial<typeof input> & { customTopic?: string } = {}) => {
    const err = await service.createCall({ ...input, ...override }, NOW).catch((e) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err.code).toBe(code);
    expect(billing.chargeForCall).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  };

  it('charges, creates and enqueues a call in one transaction', async () => {
    const call = await service.createCall(input, NOW);
    expect(call).toMatchObject({ toNumber: '+380671234567', scenarioKey: 'pizza', price: 4900, customTopic: null });
    expect(limits.lockNumber).toHaveBeenCalledWith(prisma, '+380671234567');
    expect(limits.assertWithinLimits).toHaveBeenCalledWith(prisma, '+380671234567', NOW);
    expect(billing.chargeForCall).toHaveBeenCalledWith(prisma, 'u1', 'c1', 4900);
    expect(queue.add).toHaveBeenCalledWith(JOB_PLACE_CALL, { callId: 'c1' }, expect.objectContaining({ jobId: 'place-c1' }));
    expect(moderation.moderateTopic).not.toHaveBeenCalled();
  });

  it('moderates custom topics before charging', async () => {
    await service.createCall({ ...input, scenarioKey: 'custom', customTopic: 'Сусід шукає свого папугу' }, NOW);
    expect(moderation.moderateTopic).toHaveBeenCalledWith('u1', 'Сусід шукає свого папугу', 'Оля');
    expect(billing.chargeForCall).toHaveBeenCalled();
  });

  it('rejects a custom topic that fails moderation', async () => {
    moderation.moderateTopic.mockResolvedValue({ allowed: false, category: 'threats', reason: 'погрози' });
    await expectError('MODERATION_REJECTED', { scenarioKey: 'custom', customTopic: 'Погрожуй йому' } as never);
  });

  it('rejects blocked users and users without 18+ confirmation', async () => {
    prisma.user.findUniqueOrThrow.mockResolvedValueOnce({ id: 'u1', isBlocked: true, ageConfirmedAt: new Date() });
    await expectError('USER_BLOCKED');
    prisma.user.findUniqueOrThrow.mockResolvedValueOnce({ id: 'u1', isBlocked: false, ageConfirmedAt: null });
    await expectError('AGE_NOT_CONFIRMED');
  });

  it('rejects non-Ukrainian numbers', () => expectError('INVALID_PHONE', { phone: '+48123456789' }));

  it('rejects unknown scenarios', () => expectError('UNKNOWN_SCENARIO', { scenarioKey: 'nope' }));

  it('rejects bad customer names', async () => {
    moderation.checkCustomerName.mockReturnValue({ allowed: false, category: null, reason: 'bad' });
    await expectError('INVALID_NAME');
  });

  it('rejects blocked / opted-out numbers', async () => {
    blocklist.isBlocked.mockResolvedValue(true);
    await expectError('NUMBER_BLOCKED');
  });

  it('rejects calls outside the allowed hours (Kyiv time)', async () => {
    const night = new Date('2026-10-11T21:30:00Z'); // 00:30 Kyiv
    const err = await service.createCall(input, night).catch((e) => e);
    expect(err.code).toBe('OUTSIDE_CALL_WINDOW');
  });

  it('propagates limit errors without enqueueing', async () => {
    limits.assertWithinLimits.mockRejectedValue(new DomainError('DAILY_LIMIT', 'limit'));
    await expectError('DAILY_LIMIT');
  });

  it('refunds and fails the call if it cannot be enqueued after charging', async () => {
    queue.add.mockRejectedValue(new Error('redis down'));
    const err = await service.createCall(input, NOW).catch((e) => e);
    expect(err.code).toBe('TEMPORARY_FAILURE');
    expect(prisma.call.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }));
    expect(billing.refundCall).toHaveBeenCalledWith('c1', 'enqueue failed');
  });

  it('builds agent variables for catalog and custom scenarios', () => {
    expect(CallsService.agentVariables({ id: 'c1', customerName: 'Оля', scenarioKey: 'pizza', customTopic: null })).toMatchObject({
      call_id: 'c1',
      customer_name: 'Оля',
      scenario_title: '🍕 Піца, якої не замовляли',
    });
    expect(
      CallsService.agentVariables({ id: 'c1', customerName: 'Оля', scenarioKey: 'custom', customTopic: 'папуга' }).scenario,
    ).toContain('папуга');
  });
});
