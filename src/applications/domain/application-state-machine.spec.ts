import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { ApplicationStatus as S, ReviewDecision, RiskStatus } from '../application-status.enum';
import {
  assertAssignable,
  assertEditable,
  assertTransition,
  canTransition,
  InvalidStateTransitionException,
  isEditable,
  resolveDecision,
} from './application-state-machine';

describe('application state machine', () => {
  const ALL = Object.values(S);
  const LEGAL: Array<[S, S]> = [
    [S.DRAFT, S.SUBMITTED],
    [S.SUBMITTED, S.UNDER_REVIEW],
    [S.UNDER_REVIEW, S.APPROVED],
    [S.UNDER_REVIEW, S.REJECTED],
    [S.UNDER_REVIEW, S.INFO_REQUESTED],
    [S.INFO_REQUESTED, S.SUBMITTED],
  ];
  const isLegal = (from: S, to: S) => LEGAL.some(([f, t]) => f === from && t === to);

  it.each(LEGAL)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it('rejects every transition not explicitly allowed (exhaustive)', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        if (isLegal(from, to)) continue;
        expect(canTransition(from, to)).toBe(false);
        expect(() => assertTransition(from, to)).toThrow(InvalidStateTransitionException);
      }
    }
  });

  it('treats APPROVED and REJECTED as terminal', () => {
    for (const to of ALL) {
      expect(canTransition(S.APPROVED, to)).toBe(false);
      expect(canTransition(S.REJECTED, to)).toBe(false);
    }
  });

  it('only DRAFT and INFO_REQUESTED are editable', () => {
    expect(ALL.filter(isEditable)).toEqual([S.DRAFT, S.INFO_REQUESTED]);
    expect(() => assertEditable(S.SUBMITTED)).toThrow(ConflictException);
    expect(() => assertEditable(S.APPROVED)).toThrow(ConflictException);
  });

  it('cannot assign a DRAFT or decided application', () => {
    expect(() => assertAssignable(S.DRAFT)).toThrow(ConflictException);
    expect(() => assertAssignable(S.APPROVED)).toThrow(ConflictException);
    expect(() => assertAssignable(S.REJECTED)).toThrow(ConflictException);
    expect(() => assertAssignable(S.SUBMITTED)).not.toThrow();
    expect(() => assertAssignable(S.UNDER_REVIEW)).not.toThrow();
  });

  describe('resolveDecision', () => {
    it('maps decisions to target statuses', () => {
      expect(
        resolveDecision(S.UNDER_REVIEW, RiskStatus.COMPLETED, ReviewDecision.APPROVE, undefined),
      ).toBe(S.APPROVED);
      expect(
        resolveDecision(S.UNDER_REVIEW, RiskStatus.COMPLETED, ReviewDecision.REJECT, 'fraud'),
      ).toBe(S.REJECTED);
      expect(
        resolveDecision(
          S.UNDER_REVIEW,
          RiskStatus.COMPLETED,
          ReviewDecision.REQUEST_INFO,
          'need docs',
        ),
      ).toBe(S.INFO_REQUESTED);
    });

    it.each([RiskStatus.PENDING, RiskStatus.FAILED, RiskStatus.NOT_STARTED])(
      'refuses to APPROVE when risk is %s',
      (risk) => {
        expect(() =>
          resolveDecision(S.UNDER_REVIEW, risk, ReviewDecision.APPROVE, undefined),
        ).toThrow(UnprocessableEntityException);
      },
    );

    it('allows REJECT when the risk check failed (manual review fallback)', () => {
      expect(
        resolveDecision(S.UNDER_REVIEW, RiskStatus.FAILED, ReviewDecision.REJECT, 'cannot verify'),
      ).toBe(S.REJECTED);
    });

    it.each([ReviewDecision.REJECT, ReviewDecision.REQUEST_INFO])(
      'requires a reason for %s',
      (d) => {
        expect(() => resolveDecision(S.UNDER_REVIEW, RiskStatus.COMPLETED, d, undefined)).toThrow(
          UnprocessableEntityException,
        );
        expect(() => resolveDecision(S.UNDER_REVIEW, RiskStatus.COMPLETED, d, '   ')).toThrow(
          UnprocessableEntityException,
        );
      },
    );

    it.each([S.DRAFT, S.SUBMITTED, S.INFO_REQUESTED, S.APPROVED, S.REJECTED])(
      'rejects any decision from %s',
      (from) => {
        for (const d of Object.values(ReviewDecision)) {
          expect(() => resolveDecision(from, RiskStatus.COMPLETED, d, 'reason')).toThrow(
            InvalidStateTransitionException,
          );
        }
      },
    );
  });
});
