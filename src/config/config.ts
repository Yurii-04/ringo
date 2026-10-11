import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  PUBLIC_BASE_URL: z.url(),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  TELEGRAM_BOT_TOKEN: z.string().min(1),
  /** Disable on extra replicas: only one process may long-poll Telegram. */
  BOT_POLLING: bool.default(true),
  ADMIN_TELEGRAM_IDS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => BigInt(x)),
    ),

  ELEVENLABS_API_KEY: z.string().min(1),
  ELEVENLABS_AGENT_ID: z.string().min(1),
  ELEVENLABS_PHONE_NUMBER_ID: z.string().min(1),
  ELEVENLABS_WEBHOOK_SECRET: z.string().min(1),
  ELEVENLABS_BASE_URL: z.url().default('https://api.elevenlabs.io'),

  ANTHROPIC_API_KEY: z.string().min(1),
  MODERATION_MODEL: z.string().default('claude-opus-5-5'),

  LIQPAY_PUBLIC_KEY: z.string().min(1),
  LIQPAY_PRIVATE_KEY: z.string().min(1),
  LIQPAY_SANDBOX: bool.default(true),

  /** Price of one call in kopecks. */
  CALL_PRICE: z.coerce.number().int().positive().default(4900),
  TOPUP_OPTIONS_UAH: z
    .string()
    .default('100,200,500')
    .transform((s) => s.split(',').map((x) => Number(x.trim())).filter((x) => x > 0)),
  MAX_CALL_DURATION_SEC: z.coerce.number().int().positive().max(180).default(180),
  CALLS_PER_NUMBER_PER_DAY: z.coerce.number().int().positive().default(1),
  CALLS_PER_NUMBER_PER_WEEK: z.coerce.number().int().positive().default(3),
  /** Local (Europe/Kyiv) hours in which calls are allowed: [start, end). */
  CALL_WINDOW_START_HOUR: z.coerce.number().int().min(0).max(23).default(9),
  CALL_WINDOW_END_HOUR: z.coerce.number().int().min(1).max(24).default(21),
});

export type AppConfig = z.infer<typeof envSchema>;

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
