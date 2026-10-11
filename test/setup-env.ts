import 'dotenv/config'; // DB/Redis connection only — secrets below are always regenerated
import { randomBytes } from 'crypto';

/**
 * Test environment. Secrets are generated per run — nothing sensitive is committed.
 * Connection settings can be overridden from the shell (e.g. DB_PORT=5433 npm run test:e2e).
 */
const env = process.env;
env.NODE_ENV = 'test';
env.DB_HOST ??= 'localhost';
env.DB_PORT ??= '5432';
env.DB_USERNAME ??= 'merchant';
env.DB_PASSWORD ??= '';
env.DB_NAME = env.TEST_DB_NAME ?? 'merchant_onboarding_test';
env.DB_MIGRATIONS_RUN = 'false'; // applied once in global-setup
env.REDIS_HOST ??= 'localhost';
env.REDIS_PORT ??= '6379';
env.REDIS_DB ??= '1';
// Unique queue namespace per test file so suites never consume each other's jobs.
env.BULLMQ_PREFIX = `test-${randomBytes(4).toString('hex')}`;

env.JWT_SECRET = randomBytes(48).toString('base64');
env.JWT_EXPIRES_IN = '15m';
env.FIELD_ENCRYPTION_KEY = randomBytes(32).toString('base64');

env.RISK_JOB_ATTEMPTS = '3';
env.RISK_JOB_BACKOFF_MS = '50';
env.RISK_WORKER_CONCURRENCY = '2';
env.RISK_WORKER_ENABLED = 'true';
env.RISK_PROVIDER_LATENCY_MS = '0';
env.RISK_PROVIDER_FAILURE_RATE = '0';
env.THROTTLE_LOGIN_LIMIT = '1000';
