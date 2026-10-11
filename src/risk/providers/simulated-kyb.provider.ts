import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { BusinessType, RiskLevel } from '../../applications/application-status.enum';
import {
  RiskCheckRequest,
  RiskCheckResult,
  RiskProvider,
  RiskProviderError,
} from './risk-provider.interface';

/** MCCs commonly treated as high-risk by acquirers (gambling, crypto, money transfer, ...). */
const HIGH_RISK_MCCS = new Set(['4829', '5933', '5967', '5993', '6051', '6211', '7273', '7995']);

/**
 * Stand-in for a real KYB vendor. Scoring is deterministic for a given input so results are
 * reproducible; latency and transient failures are simulated (configurable) to exercise the
 * worker's retry path. Honours idempotency keys the way a real vendor API would.
 */
@Injectable()
export class SimulatedKybProvider implements RiskProvider {
  private readonly logger = new Logger(SimulatedKybProvider.name);
  private readonly byIdempotencyKey = new Map<string, RiskCheckResult>();

  constructor(private readonly config: ConfigService) {}

  async assess(request: RiskCheckRequest, idempotencyKey: string): Promise<RiskCheckResult> {
    const cached = this.byIdempotencyKey.get(idempotencyKey);
    if (cached) return cached;

    const latency = this.config.get<number>('risk.providerLatencyMs', 300);
    if (latency > 0) await new Promise((r) => setTimeout(r, latency));

    if (Math.random() < this.config.get<number>('risk.providerFailureRate', 0)) {
      this.logger.warn(`Simulated provider timeout (key=${idempotencyKey})`);
      throw new RiskProviderError('KYB provider timeout (simulated)', true);
    }

    const result = { ...scoreApplication(request), providerReference: `sim_${idempotencyKey}` };
    this.byIdempotencyKey.set(idempotencyKey, result);
    return result;
  }
}

export function scoreApplication(
  req: RiskCheckRequest,
): Omit<RiskCheckResult, 'providerReference'> {
  const reasons: string[] = [];
  let score = 10;

  if (HIGH_RISK_MCCS.has(req.mcc)) {
    score += 45;
    reasons.push(`High-risk MCC ${req.mcc}`);
  }
  if (req.businessType === BusinessType.SOLE_PROPRIETORSHIP) {
    score += 10;
    reasons.push('Sole proprietorship');
  }
  if (req.expectedMonthlyVolumeMinor > 100_000_000) {
    score += 20;
    reasons.push('Monthly volume above 1,000,000');
  } else if (req.expectedMonthlyVolumeMinor > 25_000_000) {
    score += 10;
    reasons.push('Monthly volume above 250,000');
  }
  if (req.averageTicketMinor > 500_000) {
    score += 15;
    reasons.push('Average ticket above 5,000');
  }
  // Small deterministic "noise" so identical profiles from different entities differ slightly.
  score += createHash('sha256').update(req.legalBusinessName.toLowerCase()).digest()[0] % 8;
  score = Math.min(100, score);

  const level = score >= 70 ? RiskLevel.HIGH : score >= 40 ? RiskLevel.MEDIUM : RiskLevel.LOW;
  return { provider: 'simulated-kyb', score, level, reasons };
}
