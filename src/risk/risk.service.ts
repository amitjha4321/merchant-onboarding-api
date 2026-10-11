import { InjectQueue } from '@nestjs/bullmq';
import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { ApplicationStatus, RiskStatus } from '../applications/application-status.enum';
import { MerchantApplication } from '../applications/application.entity';
import { assertTransition } from '../applications/domain/application-state-machine';
import { AuthenticatedUser } from '../auth/authenticated-user.interface';
import {
  RISK_PROVIDER,
  RiskCheckResult,
  RiskProvider,
  RiskProviderError,
} from './providers/risk-provider.interface';
import { RISK_JOB_NAME, RISK_QUEUE, RiskQueuePayload, riskQueueJobId } from './risk.constants';
import { RiskJob } from './risk-job.entity';
import { RiskJobStatus } from './risk-job-status.enum';

export type RiskJobOutcome =
  | { kind: 'COMPLETED'; level: string; score: number }
  | { kind: 'SKIPPED'; reason: string }
  | { kind: 'FAILED'; error: string };

const ENTITY_TYPE = 'merchant_application';

@Injectable()
export class RiskService {
  private readonly logger = new Logger(RiskService.name);

  constructor(
    @InjectQueue(RISK_QUEUE) private readonly queue: Queue<RiskQueuePayload>,
    @InjectRepository(RiskJob) private readonly riskJobs: Repository<RiskJob>,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(RISK_PROVIDER) private readonly provider: RiskProvider,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // Producer side
  // ---------------------------------------------------------------------------

  /** Create the idempotency record for a submission. Must run inside the submit transaction. */
  createRiskJob(em: EntityManager, application: MerchantApplication): Promise<RiskJob> {
    return em.save(
      em.create(RiskJob, {
        applicationId: application.id,
        submissionNumber: application.submissionCount,
        status: RiskJobStatus.QUEUED,
      }),
    );
  }

  /**
   * Push the job to BullMQ. Called *after* the DB transaction commits so the worker can never
   * observe a job whose row doesn't exist yet. The deterministic jobId makes this idempotent.
   */
  async enqueue(
    riskJob: Pick<RiskJob, 'id' | 'applicationId' | 'submissionNumber'>,
  ): Promise<void> {
    const jobId = riskQueueJobId(riskJob.applicationId, riskJob.submissionNumber);

    // A previously failed BullMQ job with the same id would make `add` a silent no-op.
    const existing = await this.queue.getJob(jobId);
    if (existing && (await existing.isFailed())) await existing.remove();

    await this.queue.add(
      RISK_JOB_NAME,
      {
        riskJobId: riskJob.id,
        applicationId: riskJob.applicationId,
        submissionNumber: riskJob.submissionNumber,
      },
      {
        jobId,
        attempts: this.config.get<number>('risk.attempts', 5),
        backoff: { type: 'exponential', delay: this.config.get<number>('risk.backoffMs', 2000) },
        removeOnComplete: { age: 24 * 3600, count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    );
  }

  /**
   * Enqueue without failing the caller. If Redis is unavailable the risk job row stays QUEUED
   * and an ADMIN can re-queue it (see `requeue`); a transactional outbox would close this gap
   * fully (documented trade-off).
   */
  async enqueueSafely(riskJob: Pick<RiskJob, 'id' | 'applicationId' | 'submissionNumber'>) {
    try {
      await this.enqueue(riskJob);
    } catch (err) {
      this.logger.error(
        `Failed to enqueue risk job ${riskJob.id}; it remains QUEUED for manual re-queue`,
        (err as Error).stack,
      );
    }
  }

  /** ADMIN recovery path: re-run the risk check for the current submission. */
  async requeue(applicationId: string, actor: AuthenticatedUser): Promise<RiskJob> {
    const riskJob = await this.dataSource.transaction(async (em) => {
      const app = await em.findOne(MerchantApplication, {
        where: { id: applicationId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!app) throw new NotFoundException('Application not found');
      if (app.submissionCount === 0) {
        throw new ConflictException('Application has not been submitted');
      }

      const job = await em.findOne(RiskJob, {
        where: { applicationId, submissionNumber: app.submissionCount },
        lock: { mode: 'pessimistic_write' },
      });
      if (!job) throw new NotFoundException('Risk job not found for current submission');
      if (job.status !== RiskJobStatus.FAILED && job.status !== RiskJobStatus.QUEUED) {
        throw new ConflictException(`Risk check is ${job.status}; nothing to re-queue`);
      }

      job.status = RiskJobStatus.QUEUED;
      app.riskStatus = RiskStatus.PENDING;
      await em.save([job, app]);
      await this.audit.record(
        {
          action: AuditAction.RISK_CHECK_REQUEUED,
          actor,
          entityType: ENTITY_TYPE,
          entityId: app.id,
          metadata: { riskJobId: job.id, submissionNumber: job.submissionNumber },
        },
        em,
      );
      return job;
    });

    await this.enqueue(riskJob);
    return riskJob;
  }

  listForApplication(applicationId: string): Promise<RiskJob[]> {
    return this.riskJobs.find({ where: { applicationId }, order: { submissionNumber: 'DESC' } });
  }

  // ---------------------------------------------------------------------------
  // Consumer side (called by RiskProcessor)
  // ---------------------------------------------------------------------------

  /**
   * Process one delivery of a risk job. Safe to call any number of times for the same job:
   *  1. terminal jobs short-circuit (re-delivery / duplicate enqueue);
   *  2. stale submissions are marked SUPERSEDED;
   *  3. the provider is called with a stable idempotency key;
   *  4. the result is written under row locks, re-checking state, in one transaction
   *     together with the application update and the audit entry.
   *
   * Throws on a retryable failure (BullMQ applies exponential backoff); returns FAILED once
   * retries are exhausted or the error is non-retryable.
   */
  async processRiskJob(
    riskJobId: string,
    attempt: number,
    maxAttempts: number,
  ): Promise<RiskJobOutcome> {
    const job = await this.riskJobs.findOne({ where: { id: riskJobId } });
    if (!job) return { kind: 'SKIPPED', reason: 'risk job not found' };
    if (job.status !== RiskJobStatus.QUEUED && job.status !== RiskJobStatus.PROCESSING) {
      return { kind: 'SKIPPED', reason: `already ${job.status}` };
    }

    const app = await this.dataSource
      .getRepository(MerchantApplication)
      .findOne({ where: { id: job.applicationId } });
    if (!app || app.submissionCount !== job.submissionNumber) {
      await this.riskJobs.update(
        { id: job.id, status: job.status },
        { status: RiskJobStatus.SUPERSEDED },
      );
      return { kind: 'SKIPPED', reason: 'superseded by a newer submission' };
    }

    await this.riskJobs.update(job.id, { status: RiskJobStatus.PROCESSING, attempts: attempt });

    let result: RiskCheckResult;
    try {
      result = await this.provider.assess(
        {
          legalBusinessName: app.legalBusinessName,
          businessType: app.businessType,
          countryCode: app.countryCode,
          taxId: app.taxId,
          mcc: app.processing.mcc,
          expectedMonthlyVolumeMinor: app.processing.expectedMonthlyVolumeMinor,
          averageTicketMinor: app.processing.averageTicketMinor,
        },
        job.id,
      );
    } catch (err) {
      const message = summarizeError(err);
      const retryable = !(err instanceof RiskProviderError) || err.retryable;
      if (retryable && attempt < maxAttempts) {
        await this.riskJobs.update(job.id, { lastError: message });
        this.logger.warn(`Risk job ${job.id} attempt ${attempt}/${maxAttempts} failed: ${message}`);
        throw err;
      }
      await this.markFailed(job.id, message);
      return { kind: 'FAILED', error: message };
    }

    return this.complete(job.id, result);
  }

  private complete(riskJobId: string, result: RiskCheckResult): Promise<RiskJobOutcome> {
    return this.dataSource.transaction(async (em) => {
      const job = await em.findOneOrFail(RiskJob, {
        where: { id: riskJobId },
        lock: { mode: 'pessimistic_write' },
      });
      // A concurrent delivery may have won the race while we were calling the provider.
      if (job.status !== RiskJobStatus.QUEUED && job.status !== RiskJobStatus.PROCESSING) {
        return { kind: 'SKIPPED', reason: `already ${job.status}` } as const;
      }
      const app = await em.findOneOrFail(MerchantApplication, {
        where: { id: job.applicationId },
        lock: { mode: 'pessimistic_write' },
      });
      if (app.submissionCount !== job.submissionNumber) {
        job.status = RiskJobStatus.SUPERSEDED;
        await em.save(job);
        return { kind: 'SKIPPED', reason: 'superseded by a newer submission' } as const;
      }

      Object.assign(job, {
        status: RiskJobStatus.COMPLETED,
        provider: result.provider,
        providerReference: result.providerReference,
        score: result.score,
        level: result.level,
        reasons: result.reasons,
        lastError: null,
        completedAt: new Date(),
      });
      Object.assign(app, {
        riskStatus: RiskStatus.COMPLETED,
        riskScore: result.score,
        riskLevel: result.level,
        riskCheckedAt: job.completedAt,
      });
      this.moveToReview(app);
      await em.save([job, app]);

      await this.audit.record(
        {
          action: AuditAction.RISK_ASSESSMENT_COMPLETED,
          actor: null,
          entityType: ENTITY_TYPE,
          entityId: app.id,
          metadata: {
            riskJobId: job.id,
            submissionNumber: job.submissionNumber,
            score: result.score,
            level: result.level,
            providerReference: result.providerReference,
          },
        },
        em,
      );
      return { kind: 'COMPLETED', level: result.level, score: result.score } as const;
    });
  }

  /**
   * Retries exhausted: hand the application to manual review with riskStatus FAILED.
   * Reviewers can reject / request info, but approval stays blocked until a check completes.
   */
  async markFailed(riskJobId: string, error: string): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      const job = await em.findOne(RiskJob, {
        where: { id: riskJobId },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !job ||
        (job.status !== RiskJobStatus.QUEUED && job.status !== RiskJobStatus.PROCESSING)
      ) {
        return;
      }
      const app = await em.findOneOrFail(MerchantApplication, {
        where: { id: job.applicationId },
        lock: { mode: 'pessimistic_write' },
      });
      if (app.submissionCount !== job.submissionNumber) {
        job.status = RiskJobStatus.SUPERSEDED;
        await em.save(job);
        return;
      }

      job.status = RiskJobStatus.FAILED;
      job.lastError = error;
      app.riskStatus = RiskStatus.FAILED;
      this.moveToReview(app);
      await em.save([job, app]);

      await this.audit.record(
        {
          action: AuditAction.RISK_ASSESSMENT_FAILED,
          actor: null,
          entityType: ENTITY_TYPE,
          entityId: app.id,
          metadata: { riskJobId: job.id, attempts: job.attempts, error },
        },
        em,
      );
    });
    this.logger.error(`Risk job ${riskJobId} failed permanently: ${error}`);
  }

  private moveToReview(app: MerchantApplication): void {
    // Only the first result for a submission advances the lifecycle; a re-queued check on an
    // application already under review (or decided) just updates the risk fields.
    if (app.status === ApplicationStatus.SUBMITTED) {
      assertTransition(app.status, ApplicationStatus.UNDER_REVIEW);
      app.status = ApplicationStatus.UNDER_REVIEW;
    }
  }
}

/** Keep stored errors short and free of request payloads. */
function summarizeError(err: unknown): string {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return message.slice(0, 500);
}
