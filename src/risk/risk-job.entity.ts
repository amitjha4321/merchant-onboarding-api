import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { RiskLevel } from '../applications/application-status.enum';
import { MerchantApplication } from '../applications/application.entity';
import { RiskJobStatus } from './risk-job-status.enum';

/**
 * One risk/KYB check per application submission. Acts as the idempotency record for the
 * async worker: the (application_id, submission_number) unique key guarantees a submission
 * can't be assessed twice, and `status` lets re-delivered jobs short-circuit.
 */
@Entity('risk_jobs')
@Index('uq_risk_jobs_application_submission', ['applicationId', 'submissionNumber'], {
  unique: true,
})
export class RiskJob {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  applicationId: string;

  @ManyToOne(() => MerchantApplication, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'application_id', foreignKeyConstraintName: 'fk_risk_jobs_application' })
  application?: MerchantApplication;

  @Column({ type: 'integer' })
  submissionNumber: number;

  @Column({
    type: 'enum',
    enum: RiskJobStatus,
    enumName: 'risk_job_status',
    default: RiskJobStatus.QUEUED,
  })
  status: RiskJobStatus;

  /** Number of provider calls attempted so far (across BullMQ retries). */
  @Column({ type: 'integer', default: 0 })
  attempts: number;

  /** Truncated, non-sensitive error summary from the last failed attempt. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  lastError: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  provider: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  providerReference: string | null;

  @Column({ type: 'smallint', nullable: true })
  score: number | null;

  @Column({ type: 'enum', enum: RiskLevel, enumName: 'risk_level', nullable: true })
  level: RiskLevel | null;

  @Column({ type: 'jsonb', nullable: true })
  reasons: string[] | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
