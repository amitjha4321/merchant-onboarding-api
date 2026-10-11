import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, UnrecoverableError } from 'bullmq';
import { RISK_QUEUE, RiskQueuePayload } from './risk.constants';
import { RiskJobOutcome, RiskService } from './risk.service';

/**
 * BullMQ consumer. Deliberately thin: all business logic and idempotency handling live in
 * RiskService so they can be unit-tested without Redis.
 *
 * The worker runs in-process by default (simple local setup). RISK_WORKER_ENABLED=false lets the
 * same image run as an API-only node, with workers deployed and scaled separately.
 */
@Processor(RISK_QUEUE, { autorun: false })
export class RiskProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(RiskProcessor.name);

  constructor(
    private readonly riskService: RiskService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    if (!this.config.get<boolean>('risk.workerEnabled', true)) {
      this.logger.log('Risk worker disabled on this node (RISK_WORKER_ENABLED=false)');
      return;
    }
    this.worker.concurrency = this.config.get<number>('risk.concurrency', 5);
    // run() resolves only when the worker closes, so don't await it.
    this.worker.run().catch((err: Error) => this.logger.error('Risk worker crashed', err.stack));
  }

  async process(job: Job<RiskQueuePayload>): Promise<RiskJobOutcome> {
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;
    const outcome = await this.riskService.processRiskJob(job.data.riskJobId, attempt, maxAttempts);

    if (outcome.kind === 'FAILED') {
      // Already persisted as FAILED; stop BullMQ from retrying further.
      throw new UnrecoverableError(outcome.error);
    }
    if (outcome.kind === 'SKIPPED') {
      this.logger.log(`Risk job ${job.data.riskJobId} skipped: ${outcome.reason}`);
    }
    return outcome;
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<RiskQueuePayload> | undefined, err: Error): void {
    this.logger.warn(
      `Queue job ${job?.id} failed (attempt ${job?.attemptsMade}/${job?.opts.attempts}): ${err.message}`,
    );
  }
}
