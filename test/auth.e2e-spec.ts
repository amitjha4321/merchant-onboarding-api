import { JwtService } from '@nestjs/jwt';
import { AuditLog } from '../src/audit/audit-log.entity';
import { AuditAction } from '../src/audit/audit-action.enum';
import { Role } from '../src/users/role.enum';
import { User } from '../src/users/user.entity';
import {
  applicationPayload,
  auth,
  createTestApp,
  createUser,
  resetDatabase,
  TestContext,
} from './utils/test-app';

describe('Auth (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.close());
  beforeEach(() => resetDatabase(ctx));

  describe('POST /auth/login', () => {
    it('issues a JWT for valid credentials and never returns the password hash', async () => {
      const admin = await createUser(ctx, Role.ADMIN, { login: false });
      const res = await ctx.http
        .post('/auth/login')
        .send({ email: admin.email, password: admin.password })
        .expect(200);

      expect(res.body).toMatchObject({
        tokenType: 'Bearer',
        user: { id: admin.id, role: 'ADMIN' },
      });
      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
    });

    it('accepts the email case-insensitively', async () => {
      const u = await createUser(ctx, Role.SALES, { login: false });
      await ctx.http
        .post('/auth/login')
        .send({ email: u.email.toUpperCase(), password: u.password })
        .expect(200);
    });

    it('returns the same 401 for a wrong password and an unknown user', async () => {
      const u = await createUser(ctx, Role.SALES, { login: false });
      const wrong = await ctx.http
        .post('/auth/login')
        .send({ email: u.email, password: 'definitely-wrong' })
        .expect(401);
      const unknown = await ctx.http
        .post('/auth/login')
        .send({ email: 'nobody@example.com', password: 'definitely-wrong' })
        .expect(401);
      expect(wrong.body.message).toBe('Invalid credentials');
      expect(unknown.body.message).toBe(wrong.body.message);
    });

    it('rejects a deactivated user', async () => {
      const u = await createUser(ctx, Role.SALES, { isActive: false });
      await ctx.http.post('/auth/login').send({ email: u.email, password: u.password }).expect(401);
    });

    it('validates the payload', async () => {
      await ctx.http.post('/auth/login').send({ email: 'not-an-email', password: 'x' }).expect(400);
    });

    it('audits failed logins without storing the attempted password', async () => {
      const u = await createUser(ctx, Role.SALES, { login: false });
      await ctx.http
        .post('/auth/login')
        .send({ email: u.email, password: 'my-secret-guess-123' })
        .expect(401);

      const logs = await ctx.ds.getRepository(AuditLog).find({
        where: { action: AuditAction.LOGIN_FAILED },
      });
      expect(logs).toHaveLength(1);
      const serialized = JSON.stringify(logs);
      expect(serialized).not.toContain('my-secret-guess-123');
      expect(serialized).not.toContain(u.email); // email is masked
    });
  });

  describe('JWT route protection', () => {
    it('rejects requests without a token', async () => {
      await ctx.http.get('/applications').expect(401);
      await ctx.http.get('/auth/me').expect(401);
    });

    it('rejects a malformed token', async () => {
      await ctx.http.get('/applications').set('Authorization', 'Bearer not.a.jwt').expect(401);
    });

    it('rejects a token signed with a different secret (forged role)', async () => {
      const sales = await createUser(ctx, Role.SALES);
      const forged = new JwtService({ secret: 'attacker-controlled-secret-0123456789abcdef' }).sign(
        {
          sub: sales.id,
          email: sales.email,
          role: Role.ADMIN,
        },
      );
      await ctx.http.get('/users').set('Authorization', `Bearer ${forged}`).expect(401);
    });

    it('rejects an expired token', async () => {
      const sales = await createUser(ctx, Role.SALES);
      const expired = new JwtService({ secret: process.env.JWT_SECRET }).sign(
        { sub: sales.id, email: sales.email, role: sales.role },
        { expiresIn: -10 },
      );
      await ctx.http.get('/auth/me').set('Authorization', `Bearer ${expired}`).expect(401);
    });

    it('rejects an alg=none token', async () => {
      const sales = await createUser(ctx, Role.SALES);
      const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: sales.id, role: 'ADMIN' })}.`;
      await ctx.http.get('/users').set('Authorization', `Bearer ${unsigned}`).expect(401);
    });

    it('invalidates an existing token as soon as the user is deactivated', async () => {
      const sales = await createUser(ctx, Role.SALES);
      await ctx.http.get('/auth/me').set(auth(sales)).expect(200);
      await ctx.ds.getRepository(User).update(sales.id, { isActive: false });
      await ctx.http.get('/auth/me').set(auth(sales)).expect(401);
    });

    it('uses the role from the database, not a stale role in the token', async () => {
      const user = await createUser(ctx, Role.ADMIN);
      await ctx.http.get('/users').set(auth(user)).expect(200);
      await ctx.ds.getRepository(User).update(user.id, { role: Role.SALES });
      await ctx.http.get('/users').set(auth(user)).expect(403);
    });

    it('GET /auth/me returns the principal', async () => {
      const reviewer = await createUser(ctx, Role.REVIEWER);
      const res = await ctx.http.get('/auth/me').set(auth(reviewer)).expect(200);
      expect(res.body).toEqual({ id: reviewer.id, email: reviewer.email, role: 'REVIEWER' });
    });

    it('leaves /health public', async () => {
      await ctx.http.get('/health').expect(200);
    });
  });

  describe('role-based authorization', () => {
    it('only ADMIN can manage users', async () => {
      const admin = await createUser(ctx, Role.ADMIN);
      const sales = await createUser(ctx, Role.SALES);
      const reviewer = await createUser(ctx, Role.REVIEWER);
      const body = {
        email: 'new.reviewer@example.com',
        password: 'a-long-enough-password',
        fullName: 'New Reviewer',
        role: 'REVIEWER',
      };

      await ctx.http.post('/users').set(auth(sales)).send(body).expect(403);
      await ctx.http.post('/users').set(auth(reviewer)).send(body).expect(403);
      await ctx.http.get('/users').set(auth(sales)).expect(403);

      const res = await ctx.http.post('/users').set(auth(admin)).send(body).expect(201);
      expect(res.body).toMatchObject({ email: body.email, role: 'REVIEWER' });
      expect(res.body.password).toBeUndefined();
      expect(res.body.passwordHash).toBeUndefined();

      await ctx.http.post('/users').set(auth(admin)).send(body).expect(409);

      // The new user can log in.
      await ctx.http
        .post('/auth/login')
        .send({ email: body.email, password: body.password })
        .expect(200);
    });

    it('REVIEWER cannot create applications', async () => {
      const reviewer = await createUser(ctx, Role.REVIEWER);
      await ctx.http
        .post('/applications')
        .set(auth(reviewer))
        .send(applicationPayload())
        .expect(403);
    });

    it('only ADMIN can read the audit trail', async () => {
      const sales = await createUser(ctx, Role.SALES);
      const reviewer = await createUser(ctx, Role.REVIEWER);
      const admin = await createUser(ctx, Role.ADMIN);
      await ctx.http.get('/audit-logs').set(auth(sales)).expect(403);
      await ctx.http.get('/audit-logs').set(auth(reviewer)).expect(403);
      await ctx.http.get('/audit-logs').set(auth(admin)).expect(200);
    });
  });
});

describe('Auth rate limiting (e2e)', () => {
  let ctx: TestContext;
  const original = process.env.THROTTLE_LOGIN_LIMIT;

  beforeAll(async () => {
    process.env.THROTTLE_LOGIN_LIMIT = '3';
    ctx = await createTestApp();
  });
  afterAll(async () => {
    process.env.THROTTLE_LOGIN_LIMIT = original;
    await ctx.close();
  });

  it('throttles repeated login attempts', async () => {
    const attempt = () =>
      ctx.http
        .post('/auth/login')
        .send({ email: 'nobody@example.com', password: 'wrong-password' });
    for (let i = 0; i < 3; i++) await attempt().expect(401);
    await attempt().expect(429);
  });
});
