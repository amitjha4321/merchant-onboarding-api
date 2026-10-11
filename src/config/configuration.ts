export interface AppConfig {
  port: number;
  nodeEnv: string;
  db: {
    host: string;
    port: number;
    username: string;
    password: string;
    name: string;
    migrationsRun: boolean;
    logging: boolean;
  };
  redis: { host: string; port: number; password?: string; db: number; prefix: string };
  jwt: { secret: string; expiresIn: string };
  encryption: { key: string };
  risk: {
    attempts: number;
    backoffMs: number;
    concurrency: number;
    workerEnabled: boolean;
    providerLatencyMs: number;
    providerFailureRate: number;
  };
  throttle: { loginLimit: number };
}

/** Typed view over the (already Joi-validated) environment. */
export const configuration = (): AppConfig => {
  const env = process.env;
  const bool = (v: string | undefined) => v === 'true' || v === '1';
  return {
    port: Number(env.PORT ?? 3000),
    nodeEnv: env.NODE_ENV ?? 'development',
    db: {
      host: env.DB_HOST as string,
      port: Number(env.DB_PORT ?? 5432),
      username: env.DB_USERNAME as string,
      password: env.DB_PASSWORD ?? '',
      name: env.DB_NAME as string,
      migrationsRun: bool(env.DB_MIGRATIONS_RUN),
      logging: bool(env.DB_LOGGING),
    },
    redis: {
      host: env.REDIS_HOST as string,
      port: Number(env.REDIS_PORT ?? 6379),
      password: env.REDIS_PASSWORD || undefined,
      db: Number(env.REDIS_DB ?? 0),
      prefix: env.BULLMQ_PREFIX ?? 'merchant',
    },
    jwt: { secret: env.JWT_SECRET as string, expiresIn: env.JWT_EXPIRES_IN ?? '15m' },
    encryption: { key: env.FIELD_ENCRYPTION_KEY as string },
    risk: {
      attempts: Number(env.RISK_JOB_ATTEMPTS ?? 5),
      backoffMs: Number(env.RISK_JOB_BACKOFF_MS ?? 2000),
      concurrency: Number(env.RISK_WORKER_CONCURRENCY ?? 5),
      workerEnabled: env.RISK_WORKER_ENABLED !== 'false',
      providerLatencyMs: Number(env.RISK_PROVIDER_LATENCY_MS ?? 300),
      providerFailureRate: Number(env.RISK_PROVIDER_FAILURE_RATE ?? 0.2),
    },
    throttle: { loginLimit: Number(env.THROTTLE_LOGIN_LIMIT ?? 10) },
  };
};
