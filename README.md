# Merchant Onboarding API

NestJS service for the merchant application lifecycle: SALES create applications, a background worker runs a (simulated) third-party risk/KYB check, an ADMIN assigns a reviewer, and only that reviewer can approve, reject or request more info.

**Stack:** NestJS 10 · TypeScript (strict) · PostgreSQL + TypeORM (hand-reviewed migrations) · Redis + BullMQ · JWT (Passport) · Swagger · Jest + Supertest · Docker Compose

---

## Quick start

```bash
cp .env.example .env
# Fill in the blanks in .env:
#   DB_PASSWORD=<anything>                     (used by the postgres container)
#   JWT_SECRET=$(openssl rand -base64 48)
#   FIELD_ENCRYPTION_KEY=$(openssl rand -base64 32)
#   SEED_DEFAULT_PASSWORD=<min 12 chars>       (demo users' password)

docker compose up -d --build                  # postgres, redis, api (migrations run on boot)
docker compose exec api node dist/database/seed.js
open http://localhost:3000/docs               # Swagger UI
```

The seed creates these demo users, all with `SEED_DEFAULT_PASSWORD`: `admin@`, `reviewer@`, `reviewer2@`, `sales@` and `sales2@example.com`.

**Running locally, outside Docker:**

```bash
docker compose up -d postgres redis
npm ci
npm run migration:run && npm run seed
npm run start:dev
```

The app validates its configuration on boot (Joi) and refuses to start without a ≥32-char `JWT_SECRET` and a 32-byte `FIELD_ENCRYPTION_KEY`. No secret has a default value.

### Tests

```bash
npm test               # unit tests (no infrastructure needed)
npm run test:e2e       # integration tests: needs postgres + redis (docker compose up -d postgres redis)
npm run lint && npm run typecheck
```

The e2e suite runs against `merchant_onboarding_test`, which `docker/postgres-init.sql` creates. It refuses to run against any database whose name doesn't end in `_test`. The suite rebuilds the schema from the real migrations, generates fresh JWT and encryption secrets each run, and uses a unique BullMQ prefix per test file.

---

## API overview

| Method & path | Roles | Notes |
|---|---|---|
| `POST /auth/login` | public | Returns a JWT. Rate-limited per IP |
| `GET /auth/me` | any | Current principal |
| `POST /users`, `GET /users?role=` | ADMIN | Manage users; find reviewer ids |
| `POST /applications` | SALES, ADMIN | Creates a `DRAFT` |
| `GET /applications?status=&riskStatus=&assignedReviewerId=&page=&limit=&sortBy=&sortOrder=` | any | **Scoped** to the caller (see below) |
| `GET /applications/:id` | any | Scoped; out of scope returns **404** |
| `PATCH /applications/:id` | SALES (owner), ADMIN | Only while `DRAFT` / `INFO_REQUESTED` |
| `POST /applications/:id/submit` | SALES (owner), ADMIN | Returns **202** and enqueues the risk check |
| `POST /applications/:id/assign` | ADMIN | `{ reviewerId }`; must be an active REVIEWER |
| `POST /applications/:id/decision` | assigned REVIEWER only | `{ decision: APPROVE \| REJECT \| REQUEST_INFO, reason? }` |
| `GET /applications/:id/risk-jobs` | ADMIN, assigned REVIEWER | Risk check history |
| `POST /applications/:id/risk-jobs/requeue` | ADMIN | Recovery for a `FAILED` (or lost) check |
| `GET /audit-logs?entityId=&action=&actorId=` | ADMIN | Audit trail |
| `GET /health` | public | Checks Postgres and Redis |

All errors share one shape: `{ statusCode, error, message, path, requestId, timestamp }`. Every response carries an `x-request-id` header.

---

## Architecture

```
src/
├── auth/            login, JWT strategy, global JwtAuthGuard (secure by default; @Public() opts out)
├── users/           User entity, admin user management, bcrypt hashing
├── applications/
│   ├── domain/      application-state-machine.ts  ← pure lifecycle rules
│   │                application.policy.ts         ← pure object-level authz rules
│   ├── dto/         request validation + masked response DTOs
│   └── applications.service.ts   transactions, row locks, audit
├── risk/            RiskJob entity, RiskService (producer + idempotent consumer logic),
│                    thin BullMQ RiskProcessor, RiskProvider port + simulated KYB adapter
├── audit/           append-only AuditLog, redaction on write (global module)
├── common/          decorators, RolesGuard, exception filter, logging interceptor,
│                    request-id middleware, AES-GCM field cipher, redaction utils
├── config/          Joi env validation + typed config
└── database/        TypeORM options, CLI data source, migrations, seed
```

**Design choices:**

- **Business rules are plain functions and classes.** `application-state-machine.ts` and `application.policy.ts` have no Nest or DB dependencies. They're unit-tested exhaustively, and every command goes through them.
- **Every command runs in one DB transaction.** It does `SELECT … FOR UPDATE` on the application (scoped to the caller), then authorization, then the state-machine check, then the mutation, then the audit insert. The audit row commits atomically with the change it describes, and concurrent commands are serialized. One e2e test fires three conflicting decisions at once: exactly one succeeds and the other two get 409.
- **Global guards and pipes:** `JwtAuthGuard` → `RolesGuard` (coarse role check), and `ValidationPipe` with `whitelist` + `forbidNonWhitelisted`. Sending `status`, `createdById`, `assignedReviewerId` or similar is rejected, which prevents mass assignment.
- **The worker is thin.** `RiskProcessor` only translates BullMQ attempts into a call to `RiskService.processRiskJob`, so the idempotency and retry logic is unit-testable without Redis.

### Lifecycle

```
DRAFT ──submit──▶ SUBMITTED ──risk worker──▶ UNDER_REVIEW ──decision──▶ APPROVED  (final)
  ▲                   ▲                          │                    ▶ REJECTED  (final)
(editable)            └────────resubmit──── INFO_REQUESTED ◀───────────┘
                                              (editable)
```

- Editable only in `DRAFT` and `INFO_REQUESTED`. Assignable in `SUBMITTED`, `UNDER_REVIEW` and `INFO_REQUESTED`. Any other edge returns **409**.
- `APPROVE` requires `riskStatus = COMPLETED`. `REJECT` and `REQUEST_INFO` require a reason. Breaking either rule returns **422**.
- Resubmission increments `submissionCount`, starts a new risk check, keeps the assigned reviewer, and clears the previous decision.

---

## Security & authorization

### Object-level authorization

| | Can see (list / get) | Edit / submit | Assign | Decide |
|---|---|---|---|---|
| **SALES** | only applications they **created** | own only | ✗ | ✗ |
| **REVIEWER** | only applications **assigned to them** | ✗ | ✗ | only if assigned |
| **ADMIN** | all | ✓ | ✓ | ✗ (not the assigned reviewer) |

- Visibility is enforced **inside the SQL query** (`ApplicationPolicy.scopeFor` is merged into every `WHERE`, after user-supplied filters, so a filter can't widen the scope). An application outside the caller's scope returns the same **404** as one that doesn't exist, so IDs can't be enumerated.
- `scopeFor` throws if the principal has no id. TypeORM treats `undefined` in a `where` clause as "no filter", so this guard stops a missing id from silently matching every row.
- Re-assigning an application immediately revokes the previous reviewer's access.
- The e2e tests explicitly verify that a SALES user **cannot read, update, submit, assign or decide** on another SALES user's application by ID, and that the database row is unchanged afterwards (`test/applications.e2e-spec.ts`, "SALES isolation").

### Authentication

- JWTs are HS256, short-lived (15m default), and the algorithm is pinned (`alg=none` and forged tokens are rejected; there are tests for both).
- The JWT strategy **re-reads the user from the DB on every request**. Deactivating a user or changing their role takes effect immediately instead of at token expiry (also tested).
- Login returns the same `401 Invalid credentials` for an unknown user, a wrong password, or an inactive account. For unknown users it still compares against a dummy bcrypt hash so response timing doesn't reveal which emails exist. Login is rate-limited (`THROTTLE_LOGIN_LIMIT` per minute per IP).
- Passwords are hashed with bcrypt (cost 12). The hash column is `select: false` and is read only by the login query.

### Sensitive data

| Field | Treatment |
|---|---|
| `taxId` (EIN / registration no.) | **Field-level encrypted** (AES-256-GCM, random IV, auth tag, `v1:` version prefix for key rotation). Masked in API responses (`******1234`). Redacted in audit logs |
| `settlementAccountNumber` | **Field-level encrypted**, masked, redacted (as above) |
| `owner.email`, `owner.phone` | Plaintext (needed for search and contact). **Masked** in audit logs |
| `owner.fullName`, business names | Plaintext |
| `password` | Never stored; bcrypt hash only; redacted everywhere |
| JWTs, `Authorization` header | Never logged: the access log records only method, path, status, latency, user id and request id |

**Candidates for field-level encryption** in a production build (not collected in this scope): owner date of birth, national ID / SSN, full card PAN (should never be stored at all; use a PCI vault or tokenization), and bank routing numbers.

- `redact()` runs on **every** audit `metadata` write. It drops values for any key matching password, token, secret, authorization, taxId, account number, IBAN, card number, DOB and similar (matched on normalized key parts, so `businessName` isn't a false positive for "ssn"), and it masks emails and phone numbers.
- Update audits record **which fields changed, not their values**.
- `audit_logs` is **append-only**: a Postgres trigger rejects `UPDATE` and `DELETE`.
- Unknown errors return a generic 500. SQL errors and stack traces are logged server-side only.
- Secrets: none are committed. `.env` is git-ignored, Compose requires `DB_PASSWORD` to be set, the seed needs `SEED_DEFAULT_PASSWORD`, and the tests generate secrets at runtime. All test data is synthetic (`example.com`, obviously fake tax and account numbers).

---

## Asynchronous risk review

```
POST /submit ──tx──▶ application → SUBMITTED, submissionCount++, riskStatus=PENDING
                     risk_jobs row (QUEUED) — unique (application_id, submission_number)
                     audit APPLICATION_SUBMITTED
             ──after commit──▶ BullMQ add(jobId = "risk-<appId>-<submission>", attempts, exponential backoff)

Worker ──▶ RiskService.processRiskJob(riskJobId, attempt, maxAttempts)
   1. job row terminal (COMPLETED/FAILED/SUPERSEDED)?  → skip           (re-delivery / duplicates)
   2. application re-submitted since?                  → SUPERSEDED     (stale job)
   3. call provider with idempotencyKey = riskJob.id   (vendor-side de-dup across retries)
   4. tx: lock job + application, re-check 1 & 2, persist result,
          riskStatus=COMPLETED, SUBMITTED→UNDER_REVIEW, audit       (exactly-once effect)
   on error: retryable & attempts left → rethrow (BullMQ backoff)
             otherwise → FAILED, riskStatus=FAILED, → UNDER_REVIEW (manual review), UnrecoverableError
```

Idempotency is layered: a deterministic BullMQ `jobId`, a unique DB key per submission, a status check before work starts, a re-check under row locks before writing, and a provider idempotency key. The e2e tests cover duplicate enqueues, a rogue duplicate job with a different queue ID, **concurrent** deliveries of the same job, stale submissions, transient failures (retried, same idempotency key, applied once), exhausted retries, non-retryable errors, and the ADMIN re-queue path.

**When the check fails permanently,** the application still moves to `UNDER_REVIEW` with `riskStatus = FAILED`. A reviewer can reject it or request info, but **cannot approve** until an ADMIN re-queues the check and it completes.

**Simulated provider:** `SimulatedKybProvider` scores deterministically from MCC, business type, volume and ticket size. It simulates latency (`RISK_PROVIDER_LATENCY_MS`) and transient failures (`RISK_PROVIDER_FAILURE_RATE`, default 20%), so you can watch the retries locally.

---

## Data model

`users` · `merchant_applications` (embedded `owner_*` and `processing_*` columns; money as integer **minor units** in `bigint`; `version` column) · `risk_jobs` · `audit_logs`

- Migrations are hand-written in [`src/database/migrations`](src/database/migrations). They're verified against the entities: `npm run migration:generate` reports *no changes*, and `migration:revert` followed by `migration:run` round-trips cleanly. `synchronize` is always off.
- The schema uses Postgres enums, FKs with `ON DELETE RESTRICT` (no orphaned history), CHECK constraints (positive amounts, risk score 0–100), and indexes matching the access paths: `(created_by_id, created_at)` for SALES lists, `(assigned_reviewer_id, status)` for reviewer queues, `(status, created_at)` for admin filters, and `(entity_type, entity_id, created_at)` for the audit trail.

---

## Trade-offs & what I'd do next

| Decision (time-boxed) | Production follow-up |
|---|---|
| Enqueue happens **after** commit. If Redis is down at that moment, the job row stays `QUEUED` and an ADMIN can re-queue it | **Transactional outbox** plus a relay, or a periodic sweeper that re-enqueues stale `QUEUED` jobs |
| The worker runs in the API process by default | Already switchable with `RISK_WORKER_ENABLED=false`. Deploy workers separately and scale on queue depth |
| Encryption key comes from an env var | Envelope encryption with KMS/Vault, using the `v1:` prefix for key rotation; a blind index if lookups by tax ID are needed |
| Access tokens only, no refresh or revocation list | Refresh tokens with rotation; account lockout after N failures; MFA for ADMIN |
| Audit trail in Postgres (append-only trigger) | Separate DB role without UPDATE/DELETE grants, partition by month, stream to WORM storage or a SIEM |
| Pessimistic row locks for commands | Fine at this scale. `version` already exists if we want optimistic `If-Match` semantics for the UI |
| Offset pagination | Keyset pagination for large tables |
| Webhooks, MongoDB audit store | Optional items, not done; I prioritized the core requirements and test depth |

A short ADR for the risk-processing design is in [`docs/adr/0001-async-risk-review.md`](docs/adr/0001-async-risk-review.md).

---

## AI assistance disclosure

I used Claude Code as a coding assistant on this project. I gave it the brief
and the folder structure I wanted, and it helped me write the modules, tests
and documentation.

I didn't take the output at face value. I went through the code myself,
spending the most time on the parts where mistakes would matter most: the
object-level authorization rules, the application state machine, and how the
risk worker avoids processing the same job twice.

To check that everything works, I ran the full unit and integration test
suites against Postgres and Redis in Docker Compose. I compared the
hand-written migration with the entities (TypeORM's `migration:generate`
reports no differences) and confirmed it reverts and re-applies cleanly. I
also walked through the whole lifecycle by hand in Swagger, from creating an
application to the reviewer's final decision. Finally, I made sure no secrets
are in the repository: `.env` is git-ignored, and the tests generate their
own keys at runtime.

