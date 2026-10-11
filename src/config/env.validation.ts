import * as Joi from 'joi';

/**
 * Fail fast on boot if configuration is missing or unsafe.
 * Secrets have NO defaults on purpose — the app must be given them explicitly.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(3000),

  DB_HOST: Joi.string().required(),
  DB_PORT: Joi.number().port().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().allow('').default(''),
  DB_NAME: Joi.string().required(),
  DB_MIGRATIONS_RUN: Joi.boolean().default(false),
  DB_LOGGING: Joi.boolean().default(false),

  REDIS_HOST: Joi.string().required(),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').default(''),
  REDIS_DB: Joi.number().integer().min(0).default(0),
  BULLMQ_PREFIX: Joi.string().default('merchant'),

  JWT_SECRET: Joi.string().min(32).required(),
  JWT_EXPIRES_IN: Joi.string().default('15m'),

  FIELD_ENCRYPTION_KEY: Joi.string()
    .base64()
    .required()
    .custom((value: string, helpers) =>
      Buffer.from(value, 'base64').length === 32 ? value : helpers.error('any.invalid'),
    )
    .messages({ 'any.invalid': 'FIELD_ENCRYPTION_KEY must be base64 of exactly 32 bytes' }),

  RISK_JOB_ATTEMPTS: Joi.number().integer().min(1).default(5),
  RISK_JOB_BACKOFF_MS: Joi.number().integer().min(0).default(2000),
  RISK_WORKER_CONCURRENCY: Joi.number().integer().min(1).default(5),
  RISK_PROVIDER_LATENCY_MS: Joi.number().integer().min(0).default(300),
  RISK_PROVIDER_FAILURE_RATE: Joi.number().min(0).max(1).default(0.2),

  RISK_WORKER_ENABLED: Joi.boolean().default(true),

  THROTTLE_LOGIN_LIMIT: Joi.number().integer().min(1).default(10),
});
