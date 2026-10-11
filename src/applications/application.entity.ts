import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import { encryptedColumn } from '../common/crypto/field-cipher';
import { bigintToNumber } from '../common/utils/bigint.transformer';
import { User } from '../users/user.entity';
import { ApplicationStatus, BusinessType, RiskLevel, RiskStatus } from './application-status.enum';

/** Primary owner / contact person. Contact PII is masked in audit logs. */
export class OwnerContact {
  @Column({ type: 'varchar', length: 200 })
  fullName: string;

  @Column({ type: 'varchar', length: 320 })
  email: string;

  @Column({ type: 'varchar', length: 32 })
  phone: string;
}

/** What the merchant wants to process. Money is stored as integer minor units. */
export class ProcessingInfo {
  /** ISO 18245 merchant category code. */
  @Column({ type: 'char', length: 4 })
  mcc: string;

  @Column({ type: 'char', length: 3 })
  currency: string;

  @Column({ type: 'bigint', transformer: bigintToNumber })
  expectedMonthlyVolumeMinor: number;

  @Column({ type: 'bigint', transformer: bigintToNumber })
  averageTicketMinor: number;
}

@Entity('merchant_applications')
@Check(
  'ck_applications_amounts_positive',
  '"processing_expected_monthly_volume_minor" > 0 AND "processing_average_ticket_minor" > 0',
)
@Check('ck_applications_risk_score_range', '"risk_score" IS NULL OR "risk_score" BETWEEN 0 AND 100')
@Index('ix_applications_created_by', ['createdById', 'createdAt'])
@Index('ix_applications_reviewer_status', ['assignedReviewerId', 'status'])
@Index('ix_applications_status_created', ['status', 'createdAt'])
export class MerchantApplication {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // ---- Business ----
  @Column({ type: 'varchar', length: 200 })
  businessName: string;

  @Column({ type: 'varchar', length: 200 })
  legalBusinessName: string;

  @Column({ type: 'enum', enum: BusinessType, enumName: 'business_type' })
  businessType: BusinessType;

  /** ISO 3166-1 alpha-2. */
  @Column({ type: 'char', length: 2 })
  countryCode: string;

  @Column({ type: 'varchar', length: 2048, nullable: true })
  websiteUrl: string | null;

  /** Tax / company registration id (e.g. EIN). Encrypted at rest (AES-256-GCM). */
  @Column({ type: 'text', transformer: encryptedColumn })
  taxId: string;

  /** Settlement bank account number. Encrypted at rest (AES-256-GCM). */
  @Column({ type: 'text', nullable: true, transformer: encryptedColumn })
  settlementAccountNumber: string | null;

  // ---- Owner / contact & processing (embedded => owner_*, processing_* columns) ----
  @Column(() => OwnerContact, { prefix: 'owner' })
  owner: OwnerContact;

  @Column(() => ProcessingInfo, { prefix: 'processing' })
  processing: ProcessingInfo;

  // ---- Workflow ----
  @Column({
    type: 'enum',
    enum: ApplicationStatus,
    enumName: 'application_status',
    default: ApplicationStatus.DRAFT,
  })
  status: ApplicationStatus;

  @Column({
    type: 'enum',
    enum: RiskStatus,
    enumName: 'risk_status',
    default: RiskStatus.NOT_STARTED,
  })
  riskStatus: RiskStatus;

  @Column({ type: 'enum', enum: RiskLevel, enumName: 'risk_level', nullable: true })
  riskLevel: RiskLevel | null;

  @Column({ type: 'smallint', nullable: true })
  riskScore: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  riskCheckedAt: Date | null;

  /** Incremented on every (re)submission; ties risk assessments to a specific submission. */
  @Column({ type: 'integer', default: 0 })
  submissionCount: number;

  @Column({ type: 'timestamptz', nullable: true })
  submittedAt: Date | null;

  // ---- Ownership & assignment ----
  @Column({ type: 'uuid' })
  createdById: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'created_by_id', foreignKeyConstraintName: 'fk_applications_created_by' })
  createdBy?: User;

  @Column({ type: 'uuid', nullable: true })
  assignedReviewerId: string | null;

  @ManyToOne(() => User, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({
    name: 'assigned_reviewer_id',
    foreignKeyConstraintName: 'fk_applications_assigned_reviewer',
  })
  assignedReviewer?: User | null;

  @Column({ type: 'timestamptz', nullable: true })
  assignedAt: Date | null;

  // ---- Decision ----
  @Column({ type: 'uuid', nullable: true })
  decidedById: string | null;

  @ManyToOne(() => User, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'decided_by_id', foreignKeyConstraintName: 'fk_applications_decided_by' })
  decidedBy?: User | null;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  decisionReason: string | null;

  /** Optimistic-lock version, bumped by TypeORM on every save. */
  @VersionColumn()
  version: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
