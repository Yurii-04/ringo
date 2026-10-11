import { AppConfig, loadConfig } from '../src/config/config';

export const TEST_ENV = {
  NODE_ENV: 'test',
  PUBLIC_BASE_URL: 'https://ringo.test',
  DATABASE_URL: 'postgresql://x:y@localhost:5432/db',
  TELEGRAM_BOT_TOKEN: '123:abc',
  ADMIN_TELEGRAM_IDS: '1',
  ELEVENLABS_API_KEY: 'el-key',
  ELEVENLABS_AGENT_ID: 'agent_1',
  ELEVENLABS_PHONE_NUMBER_ID: 'phnum_1',
  ELEVENLABS_WEBHOOK_SECRET: 'whsec_test',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  LIQPAY_PUBLIC_KEY: 'pub',
  LIQPAY_PRIVATE_KEY: 'priv',
  LIQPAY_SANDBOX: 'true',
};

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({ ...TEST_ENV, ...overrides } as NodeJS.ProcessEnv);
}

/**
 * Minimal Prisma mock: every model method is a jest.fn; $transaction runs the
 * callback with the same object, so `tx` and `prisma` share expectations.
 */
export function mockPrisma() {
  const model = () => ({
    findUnique: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    upsert: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
    aggregate: jest.fn(),
    groupBy: jest.fn(),
  });
  const prisma = {
    user: model(),
    call: model(),
    transaction: model(),
    payment: model(),
    blockedNumber: model(),
    moderationLog: model(),
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));
  return prisma;
}

export type PrismaMock = ReturnType<typeof mockPrisma>;
