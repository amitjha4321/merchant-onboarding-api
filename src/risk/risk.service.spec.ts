import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import {
  ApplicationStatus,
  BusinessType,
  RiskLevel,
  RiskStatus,
} from '../applications/application-status.enum';
import { MerchantApplication } from '../applications/application.entity';
import {
  RiskCheckRequest,
  RiskCheckResult,
  RiskProvider,
  RiskProviderError,
} from './providers/risk-provider.interface';
import { RiskJob } from './risk-job.entity';
import { RiskJobStatus } from './risk-job-status.enum';
import { RiskService } from './risk.service';

/**
 * In-memory fakes for the two rows the worker touches. They model just enough of TypeORM
 * (findOne / update / save / transaction) to exercise the idempotency and retry logic.
 */
function setup(overrides: { job?: Partial<RiskJob>; app?: Partial<MerchantApplication> } = {}) {
  const job = {
    id: 'job-1',
    applicationId: 'app-1',
    submissionNumber: 1,
    status: RiskJobStatus.QUEUED,
    attempts: 0,
    lastError: null,
    ...overrides.job,
  } as RiskJob;
  const app = {
    id: 'app-1',
    legalBusinessName: 'Example Coffee LLC',
    businessType: BusinessType.LLC,
    countryCode: 'US',
    taxId: '00-0000000',
    processing: {
      mcc: '5812',
      currency: 'USD',
      expectedMonthlyVolumeMinor: 1000,
      averageTicketMinor: 10,
    },
    status: ApplicationStatus.SUBMITTED,
    riskStatus: RiskStatus.PENDING,
    submissionCount: 1,
    ...overrides.app,
  } as MerchantApplication;

  const rows = { job, app };
  const byEntity = (entity: unknown) => (entity === RiskJob ? rows.job : rows.app);

  const riskJobs = {
    findOne: jest.fn(async () => ({ ...rows.job })),
    update: jest.fn(async (criteria: string | Partial<RiskJob>, patch: Partial<RiskJob>) => {
      const c = typeof criteria === 'string' ? { id: criteria } : criteria;
      if (Object.entries(c).every(([k, v]) => rows.job[k as keyof RiskJob] === v)) {
        Object.assign(rows.job, patch);
      }
    }),
  };
  const em = {
    findOne: jest.fn(async (entity: unknown) => ({ ...byEntity(entity) })),
    findOneOrFail: jest.fn(async (entity: unknown) => ({ ...byEntity(entity) })),
    save: jest.fn(async (input: unknown) => {
      for (const e of Array.isArray(input) ? input : [input]) {
        Object.assign('submissionNumber' in e ? rows.job : rows.app, e);
      }
      return input;
    }),
  };
  const dataSource = {
    transaction: jest.fn(async (cb: (m: typeof em) => unknown) => cb(em)),
    getRepository: jest.fn(() => ({ findOne: jest.fn(async () => ({ ...rows.app })) })),
  };
  const provider: jest.Mocked<RiskProvider> = {
    assess: jest.fn<Promise<RiskCheckResult>, [RiskCheckRequest, string]>(async () => ({
      provider: 'fake',
      providerReference: 'ref-1',
      score: 42,
      level: RiskLevel.MEDIUM,
      reasons: ['test'],
    })),
  };
  const audit = { record: jest.fn(async () => undefined) };
  const config = { get: (_k: string, d: unknown) => d } as unknown as ConfigService;

  const service = new RiskService(
    {} as Queue,
    riskJobs as unknown as Repository<RiskJob>,
    dataSource as unknown as DataSource,
    provider,
    audit as unknown as AuditService,
    config,
  );
  return { service, rows, provider, audit, riskJobs };
}

describe('RiskService.processRiskJob', () => {
  it('completes: persists result, moves SUBMITTED -> UNDER_REVIEW and audits', async () => {
    const { service, rows, provider, audit } = setup();

    const outcome = await service.processRiskJob('job-1', 1, 5);

    expect(outcome).toEqual({ kind: 'COMPLETED', level: RiskLevel.MEDIUM, score: 42 });
    expect(provider.assess).toHaveBeenCalledWith(expect.any(Object), 'job-1'); // idempotency key
    expect(rows.job).toMatchObject({
      status: RiskJobStatus.COMPLETED,
      score: 42,
      providerReference: 'ref-1',
    });
    expect(rows.app).toMatchObject({
      status: ApplicationStatus.UNDER_REVIEW,
      riskStatus: RiskStatus.COMPLETED,
      riskLevel: RiskLevel.MEDIUM,
      riskScore: 42,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.RISK_ASSESSMENT_COMPLETED, actor: null }),
      expect.anything(),
    );
  });

  it.each([RiskJobStatus.COMPLETED, RiskJobStatus.FAILED, RiskJobStatus.SUPERSEDED])(
    'is idempotent: a re-delivered %s job is skipped without calling the provider',
    async (status) => {
      const { service, provider, audit } = setup({ job: { status } });
      const outcome = await service.processRiskJob('job-1', 1, 5);
      expect(outcome.kind).toBe('SKIPPED');
      expect(provider.assess).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('processing the same job twice only applies the result once', async () => {
    const { service, provider, audit } = setup();
    await service.processRiskJob('job-1', 1, 5);
    const second = await service.processRiskJob('job-1', 1, 5);
    expect(second.kind).toBe('SKIPPED');
    expect(provider.assess).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('marks the job SUPERSEDED when the application was re-submitted', async () => {
    const { service, rows, provider } = setup({ app: { submissionCount: 2 } });
    const outcome = await service.processRiskJob('job-1', 1, 5);
    expect(outcome.kind).toBe('SKIPPED');
    expect(rows.job.status).toBe(RiskJobStatus.SUPERSEDED);
    expect(provider.assess).not.toHaveBeenCalled();
  });

  it('does not overwrite state if a concurrent delivery completed first', async () => {
    const { service, rows, provider, audit } = setup();
    provider.assess.mockImplementationOnce(async () => {
      rows.job.status = RiskJobStatus.COMPLETED; // the other worker won the race
      return {
        provider: 'fake',
        providerReference: 'ref-x',
        score: 99,
        level: RiskLevel.HIGH,
        reasons: [],
      };
    });
    const outcome = await service.processRiskJob('job-1', 1, 5);
    expect(outcome.kind).toBe('SKIPPED');
    expect(rows.app.riskScore).toBeUndefined();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rethrows retryable errors while attempts remain (BullMQ applies backoff)', async () => {
    const { service, rows, provider } = setup();
    provider.assess.mockRejectedValueOnce(new RiskProviderError('timeout', true));

    await expect(service.processRiskJob('job-1', 2, 5)).rejects.toThrow('timeout');
    expect(rows.job).toMatchObject({ attempts: 2, lastError: 'RiskProviderError: timeout' });
    expect(rows.app.riskStatus).toBe(RiskStatus.PENDING);
  });

  it('marks FAILED and hands off to manual review on the final attempt', async () => {
    const { service, rows, provider, audit } = setup();
    provider.assess.mockRejectedValueOnce(new RiskProviderError('timeout', true));

    const outcome = await service.processRiskJob('job-1', 5, 5);

    expect(outcome).toEqual({ kind: 'FAILED', error: 'RiskProviderError: timeout' });
    expect(rows.job.status).toBe(RiskJobStatus.FAILED);
    expect(rows.app).toMatchObject({
      riskStatus: RiskStatus.FAILED,
      status: ApplicationStatus.UNDER_REVIEW,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.RISK_ASSESSMENT_FAILED }),
      expect.anything(),
    );
  });

  it('fails immediately on a non-retryable provider error', async () => {
    const { service, rows, provider } = setup();
    provider.assess.mockRejectedValueOnce(new RiskProviderError('invalid payload', false));
    const outcome = await service.processRiskJob('job-1', 1, 5);
    expect(outcome.kind).toBe('FAILED');
    expect(rows.job.status).toBe(RiskJobStatus.FAILED);
  });

  it('only updates risk fields (not status) when the application is already decided', async () => {
    const { service, rows } = setup({ app: { status: ApplicationStatus.REJECTED } });
    await service.processRiskJob('job-1', 1, 5);
    expect(rows.app.status).toBe(ApplicationStatus.REJECTED);
    expect(rows.app.riskStatus).toBe(RiskStatus.COMPLETED);
  });
});
