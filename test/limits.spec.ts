import { CallStatus } from '@prisma/client';
import { DomainError } from '../src/common/domain-error';
import { CallLimitsService } from '../src/limits/call-limits.service';
import { mockPrisma, PrismaMock, testConfig } from './helpers';

const NOW = new Date('2026-10-11T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

describe('CallLimitsService', () => {
  let tx: PrismaMock;
  const service = new CallLimitsService(testConfig());

  /** Simulates previous calls to the number at given ages (ms before NOW). */
  const withPreviousCalls = (agesMs: number[]) => {
    tx.call.count.mockImplementation(async ({ where }: { where: { createdAt: { gte: Date } } }) =>
      agesMs.filter((age) => NOW.getTime() - age >= where.createdAt.gte.getTime()).length,
    );
  };

  beforeEach(() => {
    tx = mockPrisma();
  });

  it('allows the first call to a number', async () => {
    withPreviousCalls([]);
    await expect(service.assertWithinLimits(tx as never, '+380671234567', NOW)).resolves.toBeUndefined();
  });

  it('blocks a second call within 24 hours', async () => {
    withPreviousCalls([23 * 60 * 60 * 1000]);
    await expect(service.assertWithinLimits(tx as never, '+380671234567', NOW)).rejects.toMatchObject({
      code: 'DAILY_LIMIT',
    });
  });

  it('allows a call after 24 hours if the weekly limit is not reached', async () => {
    withPreviousCalls([DAY + 60_000, 3 * DAY]);
    await expect(service.assertWithinLimits(tx as never, '+380671234567', NOW)).resolves.toBeUndefined();
  });

  it('blocks the 4th call within 7 days', async () => {
    withPreviousCalls([1.5 * DAY, 3 * DAY, 6.5 * DAY]);
    const err = await service.assertWithinLimits(tx as never, '+380671234567', NOW).catch((e) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err.code).toBe('WEEKLY_LIMIT');
  });

  it('forgets calls older than 7 days', async () => {
    withPreviousCalls([7 * DAY + 1000, 8 * DAY, 9 * DAY]);
    await expect(service.assertWithinLimits(tx as never, '+380671234567', NOW)).resolves.toBeUndefined();
  });

  it('counts only calls to this number and ignores calls that failed before dialing', async () => {
    withPreviousCalls([]);
    await service.assertWithinLimits(tx as never, '+380671234567', NOW);
    expect(tx.call.count).toHaveBeenCalledWith({
      where: {
        toNumber: '+380671234567',
        createdAt: { gte: new Date(NOW.getTime() - DAY) },
        status: { not: CallStatus.FAILED },
      },
    });
  });

  it('respects configured limits', async () => {
    const relaxed = new CallLimitsService(testConfig({ CALLS_PER_NUMBER_PER_DAY: '2', CALLS_PER_NUMBER_PER_WEEK: '5' }));
    withPreviousCalls([60_000]);
    await expect(relaxed.assertWithinLimits(tx as never, '+380671234567', NOW)).resolves.toBeUndefined();
  });

  it('takes a per-number advisory lock', async () => {
    await service.lockNumber(tx as never, '+380671234567');
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    const [strings, phone] = tx.$executeRaw.mock.calls[0];
    expect(strings.join('?')).toContain('pg_advisory_xact_lock');
    expect(phone).toBe('+380671234567');
  });
});
