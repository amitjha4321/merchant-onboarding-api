import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { Queue } from 'bullmq';
import { randomBytes, randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import {
  RISK_PROVIDER,
  RiskCheckRequest,
  RiskCheckResult,
  RiskProvider,
} from '../../src/risk/providers/risk-provider.interface';
import { scoreApplication } from '../../src/risk/providers/simulated-kyb.provider';
import { RISK_QUEUE } from '../../src/risk/risk.constants';
import { Role } from '../../src/users/role.enum';
import { User } from '../../src/users/user.entity';

/**
 * Controllable stand-in for the KYB vendor. `behaviour` decides each call's outcome so tests
 * can script transient failures, permanent failures or slow responses.
 */
export class FakeRiskProvider implements RiskProvider {
  calls: Array<{ key: string; request: RiskCheckRequest }> = [];
  behaviour: (key: string, callNo: number) => Promise<void> = async () => undefined;

  async assess(req: RiskCheckRequest, key: string): Promise<RiskCheckResult> {
    this.calls.push({ key, request: req });
    await this.behaviour(key, this.calls.filter((c) => c.key === key).length);
    return { ...scoreApplication(req), providerReference: `fake_${key}` };
  }

  reset(): void {
    this.calls = [];
    this.behaviour = async () => undefined;
  }
}

export interface TestContext {
  app: INestApplication;
  http: ReturnType<typeof request>;
  ds: DataSource;
  provider: FakeRiskProvider;
  queue: Queue;
  close: () => Promise<void>;
}

export async function createTestApp(): Promise<TestContext> {
  const provider = new FakeRiskProvider();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(RISK_PROVIDER)
    .useValue(provider)
    .compile();

  const app = moduleRef.createNestApplication({ logger: ['error'] });
  configureApp(app);
  await app.init();

  const ds = app.get(DataSource);
  const queue = app.get<Queue>(getQueueToken(RISK_QUEUE));
  return {
    app,
    http: request(app.getHttpServer()),
    ds,
    provider,
    queue,
    close: async () => {
      await waitForQueueIdle({ queue } as TestContext).catch(() => undefined);
      await queue.obliterate({ force: true }).catch(() => undefined);
      await app.close();
    },
  };
}

/** Wait until the worker has nothing in flight, so cleanup never races a running job. */
export async function waitForQueueIdle(ctx: TestContext): Promise<void> {
  await waitFor(async () => {
    const counts = await ctx.queue.getJobCounts('active', 'waiting', 'delayed', 'prioritized');
    return Object.values(counts).every((n) => n === 0);
  });
}

export async function resetDatabase(ctx: TestContext): Promise<void> {
  await waitForQueueIdle(ctx);
  // TRUNCATE bypasses the append-only row trigger on audit_logs (test-only cleanup).
  await ctx.ds.query(
    'TRUNCATE TABLE audit_logs, risk_jobs, merchant_applications, users RESTART IDENTITY CASCADE',
  );
}

export interface TestUser {
  id: string;
  email: string;
  role: Role;
  password: string;
  token: string;
}

/** Inserts a user directly (fast, low bcrypt cost) and logs in through the real API. */
export async function createUser(
  ctx: TestContext,
  role: Role,
  opts: { isActive?: boolean; login?: boolean } = {},
): Promise<TestUser> {
  const password = randomBytes(12).toString('hex');
  const email = `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@example.com`;
  const repo = ctx.ds.getRepository(User);
  const user = await repo.save(
    repo.create({
      email,
      role,
      fullName: `Test ${role}`,
      passwordHash: await bcrypt.hash(password, 4),
      isActive: opts.isActive ?? true,
    }),
  );
  let token = '';
  if (opts.login !== false && user.isActive) {
    const res = await ctx.http.post('/auth/login').send({ email, password }).expect(200);
    token = res.body.accessToken;
  }
  return { id: user.id, email, role, password, token };
}

export const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });

/** Synthetic, obviously-fake application data (no real people, businesses or accounts). */
export function applicationPayload(overrides: Record<string, unknown> = {}) {
  return {
    businessName: 'Example Coffee',
    legalBusinessName: 'Example Coffee LLC',
    businessType: 'LLC',
    countryCode: 'US',
    websiteUrl: 'https://coffee.example.com',
    taxId: '00-0001234',
    settlementAccountNumber: '000111222333',
    owner: { fullName: 'Test Owner', email: 'owner@example.com', phone: '+15555550100' },
    processing: {
      mcc: '5812',
      currency: 'USD',
      expectedMonthlyVolumeMinor: 5_000_000,
      averageTicketMinor: 2_500,
    },
    ...overrides,
  };
}

/** Poll until `fn` returns a truthy value (or throw after timeout). */
export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  { timeoutMs = 10_000, intervalMs = 50 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
