import { z } from 'zod';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    DB_POOL_MAX: z.coerce.number().int().positive().default(10),

    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    JWT_EXPIRES_IN: z.string().default('1h'),

    PROCESS_ROLE: z.enum(['all', 'api', 'worker']).default('all'),
    RUN_MIGRATIONS: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    WORKER_CONCURRENCY: z.coerce.number().int().positive().default(10),

    MAIL_DRIVER: z.enum(['brevo', 'smtp', 'json']).default('json'),
    MAIL_FROM_EMAIL: z.string().email().default('no-reply@example.com'),
    MAIL_FROM_NAME: z.string().default('Event Booking'),
    BREVO_API_KEY: z.string().optional(),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(465),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.MAIL_DRIVER === 'brevo' && !env.BREVO_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['BREVO_API_KEY'], message: 'Required when MAIL_DRIVER=brevo' });
    }
    if (env.MAIL_DRIVER === 'smtp' && (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS)) {
      ctx.addIssue({ code: 'custom', path: ['SMTP_HOST'], message: 'SMTP_HOST, SMTP_USER and SMTP_PASS are required when MAIL_DRIVER=smtp' });
    }
  });

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return parsed.data;
}
