import { AuditAction } from '../src/audit/audit-action.enum';
import { AuditLog } from '../src/audit/audit-log.entity';
import { MerchantApplication } from '../src/applications/application.entity';
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
} from './utils/test-app';

describe('Merchant applications (e2e)', () => {
  let ctx: TestContext;
  let admin: TestUser;
  let sales: TestUser;
  let otherSales: TestUser;
  let reviewer: TestUser;
  let otherReviewer: TestUser;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.close());

  beforeEach(async () => {
    await resetDatabase(ctx);
    ctx.provider.reset();
    [admin, sales, otherSales, reviewer, otherReviewer] = await Promise.all([
      createUser(ctx, Role.ADMIN),
      createUser(ctx, Role.SALES),
      createUser(ctx, Role.SALES),
      createUser(ctx, Role.REVIEWER),
      createUser(ctx, Role.REVIEWER),
    ]);
  });

  const createApp = async (owner: TestUser = sales, overrides = {}) =>
    (
      await ctx.http
        .post('/applications')
        .set(auth(owner))
        .send(applicationPayload(overrides))
        .expect(201)
    ).body;

  const getApp = async (id: string, as: TestUser = admin) =>
    (await ctx.http.get(`/applications/${id}`).set(auth(as)).expect(200)).body;

  /** Submit and wait for the async risk check to move the application to UNDER_REVIEW. */
  const submitAndAwaitReview = async (id: string, as: TestUser = sales) => {
    await ctx.http.post(`/applications/${id}/submit`).set(auth(as)).expect(202);
    return waitFor(async () => {
      const app = await getApp(id);
      return app.status === 'UNDER_REVIEW' && app.riskStatus === 'COMPLETED' && app;
    });
  };

  const assign = (id: string, reviewerId: string, as: TestUser = admin) =>
    ctx.http.post(`/applications/${id}/assign`).set(auth(as)).send({ reviewerId });

  const decide = (id: string, as: TestUser, decision: string, reason?: string) =>
    ctx.http.post(`/applications/${id}/decision`).set(auth(as)).send({ decision, reason });

  // ---------------------------------------------------------------------------
  describe('create', () => {
    it('creates a DRAFT owned by the caller, with sensitive fields masked', async () => {
      const app = await createApp();

      expect(app).toMatchObject({
        status: 'DRAFT',
        riskStatus: 'NOT_STARTED',
        createdById: sales.id,
        assignedReviewerId: null,
        countryCode: 'US',
        taxIdMasked: '******1234',
        settlementAccountNumberMasked: '********2333',
      });
      expect(app.taxId).toBeUndefined();
      expect(app.settlementAccountNumber).toBeUndefined();
      expect(JSON.stringify(app)).not.toContain('00-0001234');
    });

    it('encrypts tax id and account number at rest', async () => {
      const app = await createApp();
      const [row] = await ctx.ds.query(
        'SELECT tax_id, settlement_account_number FROM merchant_applications WHERE id = $1',
        [app.id],
      );
      expect(row.tax_id).toMatch(/^v1:/);
      expect(row.tax_id).not.toContain('0001234');
      expect(row.settlement_account_number).not.toContain('000111222333');
    });

    it('rejects invalid input', async () => {
      const bad = [
        applicationPayload({ businessType: 'CASINO' }),
        applicationPayload({ countryCode: 'XX' }),
        applicationPayload({ owner: { fullName: 'A', email: 'nope', phone: '123' } }),
        applicationPayload({
          processing: {
            mcc: 'abcd',
            currency: 'USD',
            expectedMonthlyVolumeMinor: 1,
            averageTicketMinor: 1,
          },
        }),
        applicationPayload({ businessName: '' }),
      ];
      for (const body of bad) {
        await ctx.http.post('/applications').set(auth(sales)).send(body).expect(400);
      }
    });

    it('blocks mass-assignment of server-controlled fields', async () => {
      for (const extra of [
        { status: 'APPROVED' },
        { createdById: otherSales.id },
        { assignedReviewerId: reviewer.id },
        { riskStatus: 'COMPLETED' },
      ]) {
        await ctx.http
          .post('/applications')
          .set(auth(sales))
          .send({ ...applicationPayload(), ...extra })
          .expect(400);
      }
    });

    it('enforces cross-field business rules (422)', async () => {
      const res = await ctx.http
        .post('/applications')
        .set(auth(sales))
        .send(
          applicationPayload({
            processing: {
              mcc: '5812',
              currency: 'USD',
              expectedMonthlyVolumeMinor: 100,
              averageTicketMinor: 500,
            },
          }),
        )
        .expect(422);
      expect(res.body.message).toMatch(/averageTicketMinor/);
    });

    it('records an audit entry with no sensitive values', async () => {
      const app = await createApp();
      const logs = await ctx.ds.getRepository(AuditLog).find({ where: { entityId: app.id } });
      expect(logs.map((l) => l.action)).toEqual([AuditAction.APPLICATION_CREATED]);
      expect(logs[0]).toMatchObject({ actorId: sales.id, actorRole: 'SALES' });
      expect(JSON.stringify(logs)).not.toMatch(/0001234|000111222333/);
    });
  });

  // ---------------------------------------------------------------------------
  describe('object-level authorization: SALES isolation', () => {
    it('a SALES user cannot read another SALES user’s application by id', async () => {
      const app = await createApp(sales);
      const res = await ctx.http.get(`/applications/${app.id}`).set(auth(otherSales)).expect(404);
      // Indistinguishable from a non-existent id: no information leak.
      const missing = await ctx.http
        .get('/applications/00000000-0000-4000-8000-000000000000')
        .set(auth(otherSales))
        .expect(404);
      expect(res.body.message).toBe(missing.body.message);
    });

    it('a SALES user cannot update another SALES user’s application by id', async () => {
      const app = await createApp(sales);
      await ctx.http
        .patch(`/applications/${app.id}`)
        .set(auth(otherSales))
        .send({ businessName: 'Hijacked' })
        .expect(404);

      const row = await ctx.ds.getRepository(MerchantApplication).findOneByOrFail({ id: app.id });
      expect(row.businessName).toBe('Example Coffee');
      expect(row.version).toBe(app.version);
    });

    it('a SALES user cannot submit another SALES user’s application', async () => {
      const app = await createApp(sales);
      await ctx.http.post(`/applications/${app.id}/submit`).set(auth(otherSales)).expect(404);
      expect((await getApp(app.id)).status).toBe('DRAFT');
    });

    it('a SALES user cannot see another’s risk jobs, assign or decide', async () => {
      const app = await createApp(sales);
      await ctx.http.get(`/applications/${app.id}/risk-jobs`).set(auth(otherSales)).expect(403);
      await assign(app.id, reviewer.id, otherSales).expect(403);
      await decide(app.id, otherSales, 'APPROVE').expect(403);
    });

    it('list only ever returns the caller’s own applications, even with filters', async () => {
      const mine = await createApp(sales);
      const theirs = await createApp(otherSales);

      const res = await ctx.http.get('/applications').set(auth(sales)).expect(200);
      expect(res.body.data.map((a: { id: string }) => a.id)).toEqual([mine.id]);
      expect(res.body.meta.total).toBe(1);

      // Trying to widen the scope through a filter does not leak anything.
      const filtered = await ctx.http
        .get('/applications')
        .query({ assignedReviewerId: reviewer.id, status: 'DRAFT' })
        .set(auth(otherSales))
        .expect(200);
      expect(filtered.body.data).toEqual([]);

      const own = await ctx.http.get('/applications').set(auth(otherSales)).expect(200);
      expect(own.body.data.map((a: { id: string }) => a.id)).toEqual([theirs.id]);
    });

    it('the owner and ADMIN can read and edit', async () => {
      const app = await createApp(sales);
      await ctx.http.get(`/applications/${app.id}`).set(auth(sales)).expect(200);
      await ctx.http.get(`/applications/${app.id}`).set(auth(admin)).expect(200);
      await ctx.http
        .patch(`/applications/${app.id}`)
        .set(auth(admin))
        .send({ websiteUrl: 'https://new.example.com' })
        .expect(200);
    });

    it('rejects non-UUID ids with 400', async () => {
      await ctx.http.get('/applications/1 OR 1=1').set(auth(sales)).expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  describe('object-level authorization: reviewers', () => {
    it('a REVIEWER only sees applications assigned to them', async () => {
      const app = await createApp();
      await ctx.http.get(`/applications/${app.id}`).set(auth(reviewer)).expect(404);

      await submitAndAwaitReview(app.id);
      await assign(app.id, reviewer.id).expect(200);

      await ctx.http.get(`/applications/${app.id}`).set(auth(reviewer)).expect(200);
      await ctx.http.get(`/applications/${app.id}`).set(auth(otherReviewer)).expect(404);
      const list = await ctx.http.get('/applications').set(auth(otherReviewer)).expect(200);
      expect(list.body.data).toEqual([]);
    });

    it('only the assigned REVIEWER may record a decision', async () => {
      const app = await createApp();
      await submitAndAwaitReview(app.id);
      await assign(app.id, reviewer.id).expect(200);

      await decide(app.id, otherReviewer, 'APPROVE').expect(404); // not visible to them
      await decide(app.id, admin, 'APPROVE').expect(403); // ADMIN is not a reviewer
      await decide(app.id, sales, 'APPROVE').expect(403);
      expect((await getApp(app.id)).status).toBe('UNDER_REVIEW');

      const res = await decide(app.id, reviewer, 'APPROVE').expect(200);
      expect(res.body).toMatchObject({ status: 'APPROVED', decidedById: reviewer.id });
    });

    it('re-assignment revokes the previous reviewer’s access', async () => {
      const app = await createApp();
      await submitAndAwaitReview(app.id);
      await assign(app.id, reviewer.id).expect(200);
      await assign(app.id, otherReviewer.id).expect(200);

      await decide(app.id, reviewer, 'APPROVE').expect(404);
      await decide(app.id, otherReviewer, 'APPROVE').expect(200);
    });

    it('a REVIEWER cannot edit an application, even one assigned to them', async () => {
      const app = await createApp();
      await submitAndAwaitReview(app.id);
      await assign(app.id, reviewer.id).expect(200);
      await ctx.http
        .patch(`/applications/${app.id}`)
        .set(auth(reviewer))
        .send({ businessName: 'x' })
        .expect(403);
    });
  });

  // ---------------------------------------------------------------------------
  describe('lifecycle', () => {
    it('allows updates while DRAFT and blocks them once submitted', async () => {
      const app = await createApp();
      const res = await ctx.http
        .patch(`/applications/${app.id}`)
        .set(auth(sales))
        .send({ businessName: 'Example Coffee & Tea' })
        .expect(200);
      expect(res.body.businessName).toBe('Example Coffee & Tea');
      expect(res.body.version).toBe(app.version + 1);

      await ctx.http.post(`/applications/${app.id}/submit`).set(auth(sales)).expect(202);
      await ctx.http
        .patch(`/applications/${app.id}`)
        .set(auth(sales))
        .send({ businessName: 'Too late' })
        .expect(409);
    });

    it('prevents double submission', async () => {
      const app = await createApp();
      await ctx.http.post(`/applications/${app.id}/submit`).set(auth(sales)).expect(202);
      const res = await ctx.http.post(`/applications/${app.id}/submit`).set(auth(sales));
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/Invalid state transition/);
    });

    it('cannot decide on an application that is not under review', async () => {
      const app = await createApp();
      // Bypass the API to assign a DRAFT (the API forbids it) and prove the decision is still blocked.
      await ctx.ds
        .getRepository(MerchantApplication)
        .update(app.id, { assignedReviewerId: reviewer.id });
      await decide(app.id, reviewer, 'APPROVE').expect(409);
    });

    it('validates assignment', async () => {
      const app = await createApp();
      await assign(app.id, reviewer.id).expect(409); // DRAFT is not assignable
      await submitAndAwaitReview(app.id);
      await assign(app.id, sales.id).expect(422); // not a reviewer
      await assign(app.id, '00000000-0000-4000-8000-000000000000').expect(422);
      await assign(app.id, reviewer.id, sales).expect(403);
      await assign(app.id, reviewer.id, reviewer).expect(403);
    });

    it('requires a reason to reject or request info', async () => {
      const app = await createApp();
      await submitAndAwaitReview(app.id);
      await assign(app.id, reviewer.id).expect(200);
      await decide(app.id, reviewer, 'REJECT').expect(422);
      await decide(app.id, reviewer, 'REQUEST_INFO', '  ').expect(422);
      await decide(app.id, reviewer, 'MAYBE').expect(400);
    });

    it('decisions are final: no transitions out of APPROVED/REJECTED', async () => {
      const app = await createApp();
      await submitAndAwaitReview(app.id);
      await assign(app.id, reviewer.id).expect(200);
      await decide(app.id, reviewer, 'REJECT', 'Unverifiable business').expect(200);

      await decide(app.id, reviewer, 'APPROVE').expect(409);
      await ctx.http.post(`/applications/${app.id}/submit`).set(auth(sales)).expect(409);
      await ctx.http
        .patch(`/applications/${app.id}`)
        .set(auth(sales))
        .send({ businessName: 'x' })
        .expect(409);
      await assign(app.id, otherReviewer.id).expect(409);
    });

    it('full happy path with request-info and resubmission', async () => {
      const app = await createApp();
      const reviewed = await submitAndAwaitReview(app.id);
      expect(reviewed).toMatchObject({ submissionCount: 1, riskLevel: expect.any(String) });

      await assign(app.id, reviewer.id).expect(200);
      const info = await decide(app.id, reviewer, 'REQUEST_INFO', 'Please provide website').expect(
        200,
      );
      expect(info.body).toMatchObject({
        status: 'INFO_REQUESTED',
        decisionReason: 'Please provide website',
      });

      // Editable again for the owner
      await ctx.http
        .patch(`/applications/${app.id}`)
        .set(auth(sales))
        .send({ websiteUrl: 'https://shop.example.com' })
        .expect(200);

      const resubmitted = await submitAndAwaitReview(app.id);
      expect(resubmitted).toMatchObject({
        submissionCount: 2,
        assignedReviewerId: reviewer.id, // keeps the same reviewer
        decisionReason: null,
      });

      const approved = await decide(app.id, reviewer, 'APPROVE').expect(200);
      expect(approved.body.status).toBe('APPROVED');

      const jobs = await ctx.http
        .get(`/applications/${app.id}/risk-jobs`)
        .set(auth(reviewer))
        .expect(200);
      expect(
        jobs.body.map((j: { submissionNumber: number; status: string }) => [
          j.submissionNumber,
          j.status,
        ]),
      ).toEqual([
        [2, 'COMPLETED'],
        [1, 'COMPLETED'],
      ]);

      const audit = await ctx.http
        .get('/audit-logs')
        .query({ entityId: app.id, limit: 50 })
        .set(auth(admin))
        .expect(200);
      const actions = audit.body.data.map((a: { action: string }) => a.action).reverse();
      expect(actions).toEqual([
        'APPLICATION_CREATED',
        'APPLICATION_SUBMITTED',
        'RISK_ASSESSMENT_COMPLETED',
        'APPLICATION_ASSIGNED',
        'APPLICATION_DECISION_RECORDED',
        'APPLICATION_UPDATED',
        'APPLICATION_SUBMITTED',
        'RISK_ASSESSMENT_COMPLETED',
        'APPLICATION_DECISION_RECORDED',
      ]);
      const decision = audit.body.data.find(
        (a: { action: string }) => a.action === 'APPLICATION_DECISION_RECORDED',
      );
      expect(decision).toMatchObject({
        actorId: reviewer.id,
        actorRole: 'REVIEWER',
        metadata: { decision: 'APPROVE', from: 'UNDER_REVIEW', to: 'APPROVED' },
      });
    });

    it('serialises concurrent decisions: exactly one wins', async () => {
      const app = await createApp();
      await submitAndAwaitReview(app.id);
      await assign(app.id, reviewer.id).expect(200);

      const results = await Promise.all([
        decide(app.id, reviewer, 'APPROVE'),
        decide(app.id, reviewer, 'REJECT', 'conflicting'),
        decide(app.id, reviewer, 'APPROVE'),
      ]);
      const codes = results.map((r) => r.status).sort();
      expect(codes.filter((c) => c === 200)).toHaveLength(1);
      expect(codes.filter((c) => c === 409)).toHaveLength(2);

      const decisions = await ctx.ds.getRepository(AuditLog).count({
        where: { entityId: app.id, action: AuditAction.APPLICATION_DECISION_RECORDED },
      });
      expect(decisions).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  describe('list: filtering & pagination', () => {
    it('filters by status and paginates', async () => {
      const a = await createApp();
      await createApp();
      await createApp();
      await ctx.http.post(`/applications/${a.id}/submit`).set(auth(sales)).expect(202);

      const drafts = await ctx.http
        .get('/applications')
        .query({ status: 'DRAFT' })
        .set(auth(sales))
        .expect(200);
      expect(drafts.body.meta.total).toBe(2);
      expect(drafts.body.data.every((x: { status: string }) => x.status === 'DRAFT')).toBe(true);

      const page2 = await ctx.http
        .get('/applications')
        .query({ limit: 2, page: 2 })
        .set(auth(sales))
        .expect(200);
      expect(page2.body.meta).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
      expect(page2.body.data).toHaveLength(1);
    });

    it('validates query params', async () => {
      await ctx.http.get('/applications').query({ limit: 1000 }).set(auth(sales)).expect(400);
      await ctx.http.get('/applications').query({ status: 'NOPE' }).set(auth(sales)).expect(400);
      await ctx.http.get('/applications').query({ sortBy: 'tax_id' }).set(auth(sales)).expect(400);
    });

    it('ADMIN sees all applications', async () => {
      await createApp(sales);
      await createApp(otherSales);
      const res = await ctx.http.get('/applications').set(auth(admin)).expect(200);
      expect(res.body.meta.total).toBe(2);
    });
  });
});
