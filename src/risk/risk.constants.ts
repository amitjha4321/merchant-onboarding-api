export const RISK_QUEUE = 'risk-review';
export const RISK_JOB_NAME = 'assess-application';

export interface RiskQueuePayload {
  riskJobId: string;
  applicationId: string;
  submissionNumber: number;
}

/**
 * Deterministic BullMQ job id: one queue job per (application, submission).
 * Enqueueing the same submission twice is a no-op at the queue level.
 */
export const riskQueueJobId = (applicationId: string, submissionNumber: number): string =>
  `risk-${applicationId}-${submissionNumber}`;
