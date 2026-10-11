import { BusinessType, RiskLevel } from '../../applications/application-status.enum';

export const RISK_PROVIDER = Symbol('RISK_PROVIDER');

export interface RiskCheckRequest {
  legalBusinessName: string;
  businessType: BusinessType;
  countryCode: string;
  taxId: string;
  mcc: string;
  expectedMonthlyVolumeMinor: number;
  averageTicketMinor: number;
}

export interface RiskCheckResult {
  provider: string;
  providerReference: string;
  score: number; // 0 (safe) .. 100 (risky)
  level: RiskLevel;
  reasons: string[];
}

/** Port for a third-party KYB / risk vendor. */
export interface RiskProvider {
  /**
   * @param idempotencyKey stable per logical check, so a retried call after a timeout
   *        returns the original result instead of creating a second check (and a second bill).
   */
  assess(request: RiskCheckRequest, idempotencyKey: string): Promise<RiskCheckResult>;
}

export class RiskProviderError extends Error {
  constructor(
    message: string,
    /** false => retrying cannot help (e.g. the vendor rejected the payload). */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'RiskProviderError';
  }
}
