export enum RiskJobStatus {
  QUEUED = 'QUEUED',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  /** Retries exhausted or non-retryable provider error. Can be re-queued by an ADMIN. */
  FAILED = 'FAILED',
  /** Application was re-submitted before this check finished; result is irrelevant. */
  SUPERSEDED = 'SUPERSEDED',
}

export const TERMINAL_RISK_JOB_STATUSES: readonly RiskJobStatus[] = [
  RiskJobStatus.COMPLETED,
  RiskJobStatus.FAILED,
  RiskJobStatus.SUPERSEDED,
];
