import { ConfigService } from '@nestjs/config';
import { BusinessType, RiskLevel } from '../../applications/application-status.enum';
import { RiskCheckRequest, RiskProviderError } from './risk-provider.interface';
import { scoreApplication, SimulatedKybProvider } from './simulated-kyb.provider';

const base: RiskCheckRequest = {
  legalBusinessName: 'Example Coffee LLC',
  businessType: BusinessType.LLC,
  countryCode: 'US',
  taxId: '00-0000000',
  mcc: '5812',
  expectedMonthlyVolumeMinor: 5_000_000,
  averageTicketMinor: 2_500,
};

const config = (failureRate: number) =>
  ({
    get: (key: string, def: unknown) =>
      key === 'risk.providerFailureRate' ? failureRate : key === 'risk.providerLatencyMs' ? 0 : def,
  }) as unknown as ConfigService;

describe('scoreApplication', () => {
  it('is deterministic', () => {
    expect(scoreApplication(base)).toEqual(scoreApplication({ ...base }));
  });

  it('rates an ordinary restaurant LOW', () => {
    expect(scoreApplication(base).level).toBe(RiskLevel.LOW);
  });

  it('rates high-risk MCC + high volume + high ticket as HIGH with reasons', () => {
    const r = scoreApplication({
      ...base,
      mcc: '7995',
      expectedMonthlyVolumeMinor: 200_000_000,
      averageTicketMinor: 600_000,
    });
    expect(r.level).toBe(RiskLevel.HIGH);
    expect(r.reasons).toEqual(expect.arrayContaining([expect.stringContaining('High-risk MCC')]));
    expect(r.score).toBeLessThanOrEqual(100);
  });
});

describe('SimulatedKybProvider', () => {
  it('returns the same result for the same idempotency key', async () => {
    const provider = new SimulatedKybProvider(config(0));
    const a = await provider.assess(base, 'key-1');
    const b = await provider.assess({ ...base, mcc: '7995' }, 'key-1');
    expect(b).toBe(a);
  });

  it('throws a retryable error when the simulated vendor fails', async () => {
    const provider = new SimulatedKybProvider(config(1));
    await expect(provider.assess(base, 'key-2')).rejects.toMatchObject({
      constructor: RiskProviderError,
      retryable: true,
    });
  });
});
