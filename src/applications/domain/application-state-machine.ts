import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { ApplicationStatus, ReviewDecision, RiskStatus } from '../application-status.enum';

const S = ApplicationStatus;

/** Every legal edge in the lifecycle graph. Anything not listed is rejected. */
const TRANSITIONS: Readonly<Record<ApplicationStatus, readonly ApplicationStatus[]>> = {
  [S.DRAFT]: [S.SUBMITTED],
  [S.SUBMITTED]: [S.UNDER_REVIEW],
  [S.UNDER_REVIEW]: [S.APPROVED, S.REJECTED, S.INFO_REQUESTED],
  [S.INFO_REQUESTED]: [S.SUBMITTED],
  [S.APPROVED]: [],
  [S.REJECTED]: [],
};

export const EDITABLE_STATUSES: readonly ApplicationStatus[] = [S.DRAFT, S.INFO_REQUESTED];
export const ASSIGNABLE_STATUSES: readonly ApplicationStatus[] = [
  S.SUBMITTED,
  S.UNDER_REVIEW,
  S.INFO_REQUESTED,
];

export class InvalidStateTransitionException extends ConflictException {
  constructor(from: ApplicationStatus, to: ApplicationStatus | string) {
    super(`Invalid state transition: ${from} -> ${to}`);
  }
}

export const canTransition = (from: ApplicationStatus, to: ApplicationStatus): boolean =>
  TRANSITIONS[from].includes(to);

export function assertTransition(from: ApplicationStatus, to: ApplicationStatus): void {
  if (!canTransition(from, to)) throw new InvalidStateTransitionException(from, to);
}

export const isEditable = (status: ApplicationStatus): boolean =>
  EDITABLE_STATUSES.includes(status);

export function assertEditable(status: ApplicationStatus): void {
  if (!isEditable(status)) {
    throw new ConflictException(`Application cannot be edited while in status ${status}`);
  }
}

export function assertAssignable(status: ApplicationStatus): void {
  if (!ASSIGNABLE_STATUSES.includes(status)) {
    throw new ConflictException(`Application cannot be assigned while in status ${status}`);
  }
}

const DECISION_TARGET: Record<ReviewDecision, ApplicationStatus> = {
  [ReviewDecision.APPROVE]: S.APPROVED,
  [ReviewDecision.REJECT]: S.REJECTED,
  [ReviewDecision.REQUEST_INFO]: S.INFO_REQUESTED,
};

/**
 * Resolve a reviewer decision to a target status, enforcing the business rules:
 *  - decisions are only possible from UNDER_REVIEW;
 *  - APPROVE requires a completed risk assessment (a FAILED check can be rejected
 *    or sent back for info, but never approved blind);
 *  - REJECT / REQUEST_INFO require a reason.
 */
export function resolveDecision(
  current: ApplicationStatus,
  riskStatus: RiskStatus,
  decision: ReviewDecision,
  reason: string | undefined,
): ApplicationStatus {
  const target = DECISION_TARGET[decision];
  assertTransition(current, target);

  if (decision === ReviewDecision.APPROVE && riskStatus !== RiskStatus.COMPLETED) {
    throw new UnprocessableEntityException(
      'Cannot approve an application without a completed risk assessment',
    );
  }
  if (decision !== ReviewDecision.APPROVE && !reason?.trim()) {
    throw new UnprocessableEntityException(`A reason is required to ${decision}`);
  }
  return target;
}
