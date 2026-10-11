# ADR 0001: Asynchronous risk review with BullMQ and a DB-backed idempotency record

- **Status:** Accepted
- **Context:** Submitting an application must trigger a third-party risk/KYB check. Vendors are slow and unreliable, so the check can't block the HTTP request. BullMQ delivers jobs *at least once*: a job can run again after a worker crash, a stalled-job recovery, a retry, or a duplicate enqueue. Paying for a check twice, or applying a stale result, is unacceptable.

## Decision

1. **One `risk_jobs` row per submission.** It's created in the same transaction as the `SUBMITTED` transition, with a unique key on `(application_id, submission_number)`. This row is the source of truth, not the queue.
2. **Enqueue after commit**, with the deterministic BullMQ `jobId = risk-<applicationId>-<submissionNumber>`. The worker therefore never sees a job whose row isn't visible yet, and a double enqueue is de-duplicated by the queue.
3. **The consumer is idempotent:**
   - it skips terminal rows;
   - it marks rows from an older submission `SUPERSEDED`;
   - it calls the provider with `idempotencyKey = risk_jobs.id`;
   - it writes the result in a single transaction that locks the job and the application, re-checks both conditions, updates the application, and inserts the audit row.
4. **Retries:** BullMQ `attempts` with exponential backoff, both configurable. The service rethrows retryable errors while attempts remain. On the final attempt, or on a non-retryable error, it persists `FAILED` and throws `UnrecoverableError`.
5. **Failure semantics:** a permanently failed check hands the application to manual review (`UNDER_REVIEW` with `riskStatus = FAILED`). Approval stays blocked until a check completes, and an ADMIN can re-queue.

## Consequences

- (+) The effect is exactly-once even though delivery is at-least-once. The idempotency logic is unit-testable without Redis.
- (+) Redis is not the system of record: losing the queue loses no business state.
- (−) A crash between commit and enqueue leaves a `QUEUED` row with no queue job. It's mitigated today by the ADMIN re-queue endpoint. A transactional outbox or a sweeper is the proper fix.
- (−) The provider can be called more than once for the same row, for example on concurrent re-delivery. That's acceptable because the provider honours the idempotency key and only one result is ever applied.

## Alternatives considered

- **Synchronous call in the request:** rejected because of latency and coupling to vendor availability.
- **Relying on BullMQ `jobId` alone:** it doesn't survive job removal or stalled re-delivery, and it doesn't protect against stale submissions.
- **A Postgres-only queue (`SKIP LOCKED`):** viable and removes Redis, but the brief requires BullMQ.
