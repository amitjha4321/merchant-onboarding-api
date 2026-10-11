import { AuditAction } from '../src/audit/audit-action.enum';
import { AuditLog } from '../src/audit/audit-log.entity';
import { MerchantApplication } from '../src/applications/application.entity';
import { RiskProviderError } from '../src/risk/providers/risk-provider.interface';
import { RISK_JOB_NAME } from '../src/risk/risk.constants';
import { RiskJob } from '../src/risk/risk-job.entity';
import { RiskJobStatus } from '../src/risk/risk-job-status.enum';
import { RiskService } from '../src/risk/risk.service';
import { Role } from '../src/users/role.enum';
import {
  applicationPayload,
  auth,
  createTestApp,
  createUser,
  resetDatabase,
  TestContext,
  TestUser,
  waitFor,
  waitForQueueIdle,
} from './utils/test-app';

describe('Asynchronous risk review (e2e)', () => {
  let ctx: TestContext;
  let admin: TestUser;
  let sales: TestUser;
  let reviewer: TestUser;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.close());

  beforeEach(async () => {
    ctx.provider.reset();
    await resetDatabase(ctx);
    [admin, sales, reviewer] = await Promise.all([
      createUser(ctx, Role.ADMIN),
      createUser(ctx, Role.SALES),
      createUser(ctx, Role.REVIEWER),
    ]);
  });

  const createAndSubmit = async (overrides = {}) => {
    const created = await ctx.http
      .post('/applications')
      .set(auth(sales))
      .send(applicationPayload(overrides))
      .expect(201);
    const submitted = await ctx.http
      .post(`/applications/${created.body.id}/submit`)
      .set(auth(sales))
      .expect(202);
    return submitted.body;
  };

  const riskJobsFor = (applicationId: string) =>
    ctx.ds.getRepository(RiskJob).find({ where: { applicationId } });

  const appRow = (id: string) => ctx.ds.getRepository(MerchantApplication).findOneByOrFail({ id });

  const waitForJob = (applicationId: string, status: RiskJobStatus) =>
    waitFor(async () => {
      const [job] = await riskJobsFor(applicationId);
      return job?.status === status && job;
    });

  const auditCount = (entityId: string, action: AuditAction) =>
    ctx.ds.getRepository(AuditLog).count({ where: { entityId, action } });

  it('submission responds immediately and enqueues a background risk check', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    ctx.provider.behaviour = () => gate; // hold the provider until we've inspected state

    const app = await createAndSubmit();
    expect(app).toMatchObject({ status: 'SUBMITTED', riskStatus: 'PENDING', submissionCount: 1 });

    const [job] = await riskJobsFor(app.id);
    expect(job).toMatchObject({ submissionNumber: 1 });
    expect([RiskJobStatus.QUEUED, RiskJobStatus.PROCESSING]).toContain(job.status);

    release();
    const done = await waitForJob(app.id, RiskJobStatus.COMPLETED);
    expect(done).toMatchObject({
      attempts: 1,
      provider: 'simulated-kyb',
      providerReference: `fake_${job.id}`,
      score: expect.any(Number),
      level: expect.stringMatching(/LOW|MEDIUM|HIGH/),
    });

    const row = await appRow(app.id);
    expect(row).toMatchObject({
      status: 'UNDER_REVIEW',
      riskStatus: 'COMPLETED',
      riskScore: done.score,
      riskLevel: done.level,
    });
    expect(row.riskCheckedAt).toBeInstanceOf(Date);
    expect(await auditCount(app.id, AuditAction.RISK_ASSESSMENT_COMPLETED)).toBe(1);
  });

  it('passes the decrypted data to the provider but never stores it in the job', async () => {
    const app = await createAndSubmit();
    await waitForJob(app.id, RiskJobStatus.COMPLETED);
    expect(ctx.provider.calls[0].request).toMatchObject({ taxId: '00-0001234', mcc: '5812' });
    const [raw] = await ctx.ds.query('SELECT row_to_json(r)::text AS j FROM risk_jobs r');
    expect(raw.j).not.toContain('0001234');
  });

  it('scores a high-risk profile HIGH', async () => {
    const app = await createAndSubmit({
      processing: {
        mcc: '7995',
        currency: 'USD',
        expectedMonthlyVolumeMinor: 500_000_000,
        averageTicketMinor: 900_000,
      },
    });
    const job = await waitForJob(app.id, RiskJobStatus.COMPLETED);
    expect(job.level).toBe('HIGH');
  });

  it('retries transient provider failures with backoff, reusing the same idempotency key', async () => {
    ctx.provider.behaviour = async (_key, callNo) => {
      if (callNo < 3) throw new RiskProviderError('vendor timeout', true);
    };

    const app = await createAndSubmit();
    const job = await waitForJob(app.id, RiskJobStatus.COMPLETED);

    expect(ctx.provider.calls).toHaveLength(3);
    expect(new Set(ctx.provider.calls.map((c) => c.key))).toEqual(new Set([job.id]));
    expect(job).toMatchObject({ attempts: 3, lastError: null });
    expect((await appRow(app.id)).riskStatus).toBe('COMPLETED');
    expect(await auditCount(app.id, AuditAction.RISK_ASSESSMENT_COMPLETED)).toBe(1);
  });

  it('after exhausting retries: FAILED, manual review, approval blocked, ADMIN can re-queue', async () => {
    ctx.provider.behaviour = async () => {
      throw new RiskProviderError('vendor down', true);
    };

    const app = await createAndSubmit();
    const failed = await waitForJob(app.id, RiskJobStatus.FAILED);
    expect(failed).toMatchObject({ attempts: 3, lastError: 'RiskProviderError: vendor down' });
    expect(ctx.provider.calls).toHaveLength(3); // RISK_JOB_ATTEMPTS=3 in tests
    expect(await appRow(app.id)).toMatchObject({ status: 'UNDER_REVIEW', riskStatus: 'FAILED' });
    expect(await auditCount(app.id, AuditAction.RISK_ASSESSMENT_FAILED)).toBe(1);

    await ctx.http
      .post(`/applications/${app.id}/assign`)
      .set(auth(admin))
      .send({ reviewerId: reviewer.id })
      .expect(200);
    const blocked = await ctx.http
      .post(`/applications/${app.id}/decision`)
      .set(auth(reviewer))
      .send({ decision: 'APPROVE' })
      .expect(422);
    expect(blocked.body.message).toMatch(/risk assessment/);

    // Only ADMIN can re-queue.
    await ctx.http
      .post(`/applications/${app.id}/risk-jobs/requeue`)
      .set(auth(reviewer))
      .expect(403);
    await ctx.http.post(`/applications/${app.id}/risk-jobs/requeue`).set(auth(sales)).expect(403);

    ctx.provider.behaviour = async () => undefined; // vendor recovered
    await ctx.http.post(`/applications/${app.id}/risk-jobs/requeue`).set(auth(admin)).expect(202);
    await waitForJob(app.id, RiskJobStatus.COMPLETED);
    expect(await appRow(app.id)).toMatchObject({ status: 'UNDER_REVIEW', riskStatus: 'COMPLETED' });

    await ctx.http
      .post(`/applications/${app.id}/decision`)
      .set(auth(reviewer))
      .send({ decision: 'APPROVE' })
      .expect(200);

    // A completed check cannot be re-queued.
    await ctx.http.post(`/applications/${app.id}/risk-jobs/requeue`).set(auth(admin)).expect(409);
  });

  it('non-retryable provider errors fail immediately without further attempts', async () => {
    ctx.provider.behaviour = async () => {
      throw new RiskProviderError('payload rejected', false);
    };
    const app = await createAndSubmit();
    await waitForJob(app.id, RiskJobStatus.FAILED);
    await waitForQueueIdle(ctx);
    expect(ctx.provider.calls).toHaveLength(1);
  });

  it('is idempotent under duplicate delivery: provider called once, result applied once', async () => {
    const app = await createAndSubmit();
    const job = await waitForJob(app.id, RiskJobStatus.COMPLETED);
    const before = await appRow(app.id);

    // 1) Same deterministic job id: BullMQ de-duplicates (or our row short-circuits).
    await ctx.app.get(RiskService).enqueue(job);
    // 2) A rogue duplicate with a *different* queue id but the same payload.
    await ctx.queue.add(RISK_JOB_NAME, {
      riskJobId: job.id,
      applicationId: app.id,
      submissionNumber: 1,
    });
    await waitForQueueIdle(ctx);

    expect(ctx.provider.calls).toHaveLength(1);
    expect(await auditCount(app.id, AuditAction.RISK_ASSESSMENT_COMPLETED)).toBe(1);
    const after = await appRow(app.id);
    expect(after.version).toBe(before.version);
    expect(after.riskCheckedAt).toEqual(before.riskCheckedAt);
  });

  it('concurrent deliveries of the same job apply the result exactly once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    ctx.provider.behaviour = () => gate;

    const app = await createAndSubmit();
    const [job] = await riskJobsFor(app.id);
    // Second delivery (worker concurrency is 2) while the first is blocked in the provider.
    await ctx.queue.add(RISK_JOB_NAME, {
      riskJobId: job.id,
      applicationId: app.id,
      submissionNumber: 1,
    });
    await waitFor(async () => ctx.provider.calls.length === 2);
    release();
    await waitForQueueIdle(ctx);

    expect((await riskJobsFor(app.id))[0].status).toBe(RiskJobStatus.COMPLETED);
    expect(await auditCount(app.id, AuditAction.RISK_ASSESSMENT_COMPLETED)).toBe(1);
  });

  it('a stale check for an older submission never overwrites the newer one', async () => {
    const app = await createAndSubmit();
    const first = await waitForJob(app.id, RiskJobStatus.COMPLETED);

    // Simulate a re-submission happening (submission #2) and a late redelivery of #1.
    await ctx.ds.getRepository(RiskJob).update(first.id, { status: RiskJobStatus.QUEUED });
    await ctx.ds
      .getRepository(MerchantApplication)
      .update(app.id, { submissionCount: 2, riskStatus: 'PENDING' as never });
    await ctx.queue.add(RISK_JOB_NAME, {
      riskJobId: first.id,
      applicationId: app.id,
      submissionNumber: 1,
    });
    await waitForQueueIdle(ctx);

    const stale = await ctx.ds.getRepository(RiskJob).findOneByOrFail({ id: first.id });
    expect(stale.status).toBe(RiskJobStatus.SUPERSEDED);
    expect((await appRow(app.id)).riskStatus).toBe('PENDING');
  });

  it('exposes risk history only within the caller’s scope', async () => {
    const app = await createAndSubmit();
    await waitForJob(app.id, RiskJobStatus.COMPLETED);

    await ctx.http.get(`/applications/${app.id}/risk-jobs`).set(auth(reviewer)).expect(404);
    await ctx.http
      .post(`/applications/${app.id}/assign`)
      .set(auth(admin))
      .send({ reviewerId: reviewer.id })
      .expect(200);
    const res = await ctx.http
      .get(`/applications/${app.id}/risk-jobs`)
      .set(auth(reviewer))
      .expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ status: 'COMPLETED', submissionNumber: 1 });
  });
});
