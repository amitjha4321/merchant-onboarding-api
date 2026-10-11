/**
 * Lifecycle of a merchant application.
 *
 *   DRAFT ──submit──▶ SUBMITTED ──risk worker──▶ UNDER_REVIEW ──decision──▶ APPROVED
 *     ▲                   ▲                          │                    ▶ REJECTED
 *     │                   └──────resubmit────── INFO_REQUESTED ◀──────────┘
 *  (editable)                                    (editable)
 */
export enum ApplicationStatus {
  DRAFT = 'DRAFT',
  SUBMITTED = 'SUBMITTED',
  UNDER_REVIEW = 'UNDER_REVIEW',
  INFO_REQUESTED = 'INFO_REQUESTED',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

/** Status of the asynchronous third-party risk/KYB check for the current submission. */
export enum RiskStatus {
  NOT_STARTED = 'NOT_STARTED',
  PENDING = 'PENDING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

export enum RiskLevel {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
}

export enum BusinessType {
  SOLE_PROPRIETORSHIP = 'SOLE_PROPRIETORSHIP',
  PARTNERSHIP = 'PARTNERSHIP',
  LLC = 'LLC',
  CORPORATION = 'CORPORATION',
  NON_PROFIT = 'NON_PROFIT',
}

export enum ReviewDecision {
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
  REQUEST_INFO = 'REQUEST_INFO',
}
